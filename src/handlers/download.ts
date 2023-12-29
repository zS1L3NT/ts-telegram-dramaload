import axios from "axios"
import { load } from "cheerio"
import { unlink } from "fs/promises"
import { InlineKeyboardMarkup } from "node-telegram-bot-api"
import { resolve } from "path"
import { Builder, By, until, WebDriver } from "selenium-webdriver"
import { Options } from "selenium-webdriver/chrome"

import { caches, DownloadCache, RecaptchaCache, sessions } from "../db"
import Handler from "./handler"

export default class DownloadHandler extends Handler<DownloadCache["actions"][number]> {
	private driver!: WebDriver
	private frame: "main" | "check" | "popup" = "main"
	private photoId: number | null = null
	private buffer = Buffer.from([])

	private async closeOtherTabs() {
		await this.driver.sleep(1000)
		const handles = await this.driver.getAllWindowHandles()

		for (const handle of handles.slice(1)) {
			await this.driver.switchTo().window(handle)
			await this.driver.close()
		}

		await this.driver.switchTo().window(handles[0]!)
		await this.switchFrame(this.frame)
	}

	private async switchFrame(frame: "main" | "check" | "popup") {
		if (this.frame !== "main") {
			await this.driver.switchTo().frame(null)
		}

		if (frame !== "main") {
			let selector!: By
			switch (frame) {
				case "check":
					selector = By.css("#content-download iframe")
					break
				case "popup":
					selector = By.css('iframe[title="recaptcha challenge expires in two minutes"]')
					break
			}

			await this.driver.wait(until.elementLocated(selector), 60_000)
			await this.driver.switchTo().frame(this.driver.findElement(selector))
		}

		this.frame = frame
	}

	private async checkForCleanup(photoId?: number) {
		if (await sessions.findOne({ chatId: this.chatId, messageId: this.responseId })) {
			return false
		}

		try {
			await Promise.allSettled([
				this.driver?.quit(),
				this.bot.deleteMessage(this.chatId, this.responseId),
				unlink(resolve("videos", this.data.show, (this.data.episode + "").padStart(2, "0") + ".mp4")),
			])

			if (photoId) {
				await Promise.allSettled([
					this.bot.deleteMessage(this.chatId, photoId),
					caches.deleteOne({ chatId: this.chatId, messageId: photoId }),
				])
			}
		} catch {
			/**/
		}

		return true
	}

	private async updateRecaptcha() {
		await this.switchFrame("main")
		const buffer = await this.driver
			.findElement(By.css('iframe[title="recaptcha challenge expires in two minutes"]'))
			.takeScreenshot()
			.then(i => Buffer.from(i, "base64"))
		await this.switchFrame("popup")

		const size = (await this.driver.findElements(By.css("table tbody tr"))).length
		const markup: InlineKeyboardMarkup = {
			inline_keyboard: [
				...Array(size)
					.fill(0)
					.map((_, i) =>
						Array(size)
							.fill(0)
							.map((_, j) => i * size + j + 1 + "")
							.map(v => ({
								text: v,
								callback_data: `${this.chatId},0,${v}`,
							})),
					),
				[
					{
						text: await this.driver.findElement(By.css(".verify-button-holder button")).getText(),
						callback_data: `${this.chatId},0,0`,
					},
				],
			],
		}

		if (!this.photoId) {
			this.buffer = buffer
			this.photoId = await Promise.all([
				this.bot.sendPhoto(this.chatId, buffer, { reply_markup: markup }).then(m => m.message_id),
				this.log(["Please type the square numbers that match the criteria"].join("\n\n")),
			]).then(([photoId]) => photoId)
		} else if (!this.buffer.equals(buffer)) {
			this.buffer = buffer
			const path = resolve((Math.random() + "").slice(2) + ".jpg")
			await Bun.write(path, buffer)
			await this.bot.editMessageMedia(
				{ type: "photo", media: "attach://" + path },
				{ chat_id: this.chatId, message_id: this.photoId, reply_markup: markup },
			)
			setTimeout(() => unlink(path), 1000)
		}
	}

	private async sendLinks() {
		const as = await this.driver.findElements(By.css(".mirror_link:first-of-type div a"))
		const links = await Promise.all(
			as.map(
				async a =>
					`[Download ${await a
						.getText()
						.then(t => t.match(/\d+P/)![0]!.toLowerCase())}](${await a.getAttribute("href")})`,
			),
		)

		await this.driver.quit()
		await this.log(links.map(l => "\n" + l).join(""), true)
	}

	override async start() {
		await sessions.insertOne({ chatId: this.chatId, messageId: this.responseId })

		const slug =
			this.data.show
				.replaceAll(/[^a-zA-Z0-9\s]/g, "")
				.replaceAll(" ", "-")
				.toLowerCase() +
			"-episode-" +
			this.data.episode
		const html = await axios.get(`https://draplay2.pro/videos/${slug}`).then(r => r.data)
		const fullscreenUrl = ("http:" + load(html)("iframe").attr("src")).replace("play.php", "download")

		if (await this.checkForCleanup()) return
		await this.log("Starting browser...")
		const driver = await new Builder()
			.forBrowser("chrome")
			.setChromeOptions(
				new Options()
					.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--start-maximised")
					.windowSize({
						width: 1920,
						height: 1080,
					}),
			)
			.build()
		this.driver = driver

		if (await this.checkForCleanup()) return
		await driver.get(fullscreenUrl)
		await this.log("Checking for download links...")

		let found = false
		try {
			await driver.wait(until.elementLocated(By.css(".mirror_link")), 5000)
			found = true
		} catch {
			/**/
		}

		if (found) {
			await this.sendLinks()
			return
		}

		if (await this.checkForCleanup()) return
		await this.log(`No download links found, waiting for recaptcha...`)
		await this.switchFrame("check")

		await driver.wait(until.elementLocated(By.css(".recaptcha-checkbox-border")), 30_000)
		await driver.executeScript("document.querySelector('.recaptcha-checkbox-border').click()")
		await this.closeOtherTabs()
		await driver.sleep(500)

		if (await this.checkForCleanup()) return
		await this.switchFrame("popup")

		await this.updateRecaptcha()

		let cache: RecaptchaCache = {
			type: "recaptcha",
			chatId: this.chatId,
			messageId: this.photoId!,
			queued: [],
			date: Date.now(),
		}

		await caches.insertOne(cache)
		await driver.executeScript("document.querySelector('.rc-imageselect-challenge').click()")
		await this.closeOtherTabs()

		let finished = false
		let clicked = 0
		while (Date.now() - cache.date < 100000 || !finished) {
			if (await this.checkForCleanup(this.photoId!)) return
			if (
				await driver
					.findElement(By.id("recaptcha-reload-button"))
					.then(async e => (await e.getAttribute("class")).includes("rc-button-disabled"))
			) {
				finished = true
				break
			}

			if (clicked !== cache.queued.length) {
				let size = (await driver.findElements(By.css("table tbody tr"))).length
				if ([6, 8].includes(size)) size /= 2

				for (const square of cache.queued.slice(clicked)) {
					if (square === 0) {
						await driver.executeScript("document.querySelector('#recaptcha-verify-button').click()")
						await driver.sleep(250)
					} else {
						const index = square - 1
						const x = (index % size) + 1
						const y = ((index / size) | 0) + 1
						await driver.executeScript(
							`document.querySelector('table tr:nth-of-type(${y}) td:nth-of-type(${x})').click()`,
						)
						await driver.sleep(250)
					}
					clicked++
				}
			}

			await this.updateRecaptcha()

			await driver.sleep(250)
			cache = (await caches.findOne<RecaptchaCache>({ chatId: this.chatId, messageId: this.photoId! }))!
		}

		await caches.deleteOne({ chatId: this.chatId, messageId: this.photoId! })
		await this.bot.deleteMessage(this.chatId, this.photoId!)

		if (!finished) {
			await this.log("Recaptcha timed out", true)
			await driver.quit()
			await sessions.deleteOne({ chatId: this.chatId, messageId: this.responseId })
			return
		}

		await this.switchFrame("main")
		await driver.executeScript("document.querySelector('#btn-submit').click()")

		if (await this.checkForCleanup()) return
		found = false
		try {
			await driver.wait(until.elementLocated(By.css(".mirror_link")), 5000)
			found = true
		} catch {
			/**/
		}

		if (!found) {
			await this.log("Recaptcha failed", true)
			await driver.quit()
			await sessions.deleteOne({ chatId: this.chatId, messageId: this.responseId })
			return
		}

		await this.sendLinks()
	}
}
