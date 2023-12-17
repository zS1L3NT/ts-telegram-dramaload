import axios, { AxiosProgressEvent } from "axios"
import { load } from "cheerio"
import { createWriteStream } from "fs"
import { exists, mkdir } from "fs/promises"
import { resolve } from "path"
import { Builder, By, until, WebDriver } from "selenium-webdriver"
import { Options } from "selenium-webdriver/chrome"
import { Stream } from "stream"

import { IDownloadAction, IRecaptchaAction } from "../app"
import { getCache, setCache, setRCLock } from "../cache"
import Action from "./action"

export default class DownloadAction extends Action<IDownloadAction> {
	private lastUpdate = Date.now()
	private frame: "main" | "check" | "popup" = "main"
	private driver!: WebDriver

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

	override async start() {
		const slug =
			this.action.show
				.replaceAll(/[^a-zA-Z0-9\s]/g, "")
				.replaceAll(" ", "-")
				.toLowerCase() +
			"-episode-" +
			this.action.episode
		const html = await axios.get(`https://draplay2.pro/videos/${slug}`).then(r => r.data)
		const fullscreenUrl = ("http:" + load(html)("iframe").attr("src")).replace("play.php", "download")

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

		let image = Buffer.from([])
		// eslint-disable-next-line no-constant-condition
		while (true) {
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
				const a = await driver.findElement(By.css(".mirror_link:first-of-type div:last-of-type a"))
				const href = await a.getAttribute("href")
				const quality = await a.getText().then(t => t.match(/\d+P/)![0]!)

				await driver.quit()
				await this.respond(href, quality)
				return
			}

			await this.log("No download links found, waiting for recaptcha...")
			await this.switchFrame("check")

			await driver.wait(until.elementLocated(By.css(".recaptcha-checkbox-border")), 30_000)
			await driver.executeScript("document.querySelector('.recaptcha-checkbox-border').click()")
			await this.closeOtherTabs()

			await this.switchFrame("popup")
			const message = await driver.findElement(By.css(".rc-imageselect-instructions")).getText()
			if (message.includes("none left") || message.includes("skip")) {
				await this.log("Multi-step recaptcha detected, refreshing...")
			} else if (!message) {
				await this.log("No recaptcha message detected, refreshing...")
			} else {
				await driver.sleep(500)
				await this.switchFrame("main")
				image = Buffer.from(
					await driver
						.findElement(By.css('iframe[title="recaptcha challenge expires in two minutes"]'))
						.takeScreenshot(),
					"base64",
				)

				break
			}
		}

		await this.log("Waiting for recaptcha completion...")
		await this.switchFrame("popup")
		const size = (await driver.findElements(By.css("table tbody tr"))).length

		const [photoId] = await Promise.all([
			this.bot
				.sendPhoto(this.chatId, image, {}, { filename: this.action.show + ".jpg", contentType: "image/jpeg" })
				.then(m => m.message_id),
			this.log(
				[
					"Please type the square numbers that match the criteria in comma seperated form",
					`Numbers must be between 1 ~ ${Math.pow(size, 2)} since the image is ${size}x${size}. Example:`,
					"`1,3,4,9`\n`8,11,15,16`",
				].join("\n\n"),
			),
		])

		setRCLock(this.messageId)
		await setCache(this.messageId, [
			{
				type: "Recaptcha",
				squares: null,
				date: Date.now(),
			},
		])

		while (Date.now() - (await getCache<IRecaptchaAction>(this.messageId))![0]!.date < 120_000) {
			if ((await getCache<IRecaptchaAction>(this.messageId))![0]!.squares) break
			await driver.sleep(3000)
		}

		await this.bot.deleteMessage(this.chatId, photoId)

		const { squares } = (await getCache<IRecaptchaAction>(this.messageId))![0]!
		if (!squares) {
			await this.log("Recaptcha timed out")
			await driver.quit()
			setRCLock(null)
			return
		}

		await this.log("Clicking squares: " + squares.map(s => s + 1).join(", "))
		await driver.executeScript("document.querySelector('.rc-imageselect-challenge').click()")
		await this.closeOtherTabs()

		for (const number of squares) {
			await driver.sleep(250)
			const x = (number % size) + 1
			const y = ((number / size) | 0) + 1
			await driver.executeScript(
				`document.querySelector('table tr:nth-of-type(${y}) td:nth-of-type(${x})').click()`,
			)
		}

		await driver.executeScript("document.querySelector('#recaptcha-verify-button').click()")
		await driver.sleep(500)

		await this.switchFrame("main")
		await driver.executeScript("document.querySelector('#btn-submit').click()")

		let found = false
		try {
			await driver.wait(until.elementLocated(By.css(".mirror_link")), 5000)
			found = true
		} catch {
			/**/
		}

		if (!found) {
			await this.log("Recaptcha failed")
			await driver.quit()
			return
		}

		const a = await driver.findElement(By.css(".mirror_link:first-of-type div:last-of-type a"))
		const href = await a.getAttribute("href")
		const quality = await a.getText().then(t => t.match(/\d+P/)![0]!)

		await driver.quit()
		await this.respond(href, quality)
	}

	private formatSize(size: number) {
		const i = size == 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024))
		return (size / Math.pow(1024, i)).toFixed(2) + " " + ["B", "kB", "MB", "GB", "TB"][i]
	}

	private formatProgress(event: AxiosProgressEvent, quality: string) {
		return [
			`Quality: ${quality.toLowerCase()}`,
			event.total !== undefined
				? `Progress: ${this.formatSize(event.loaded)} / ${this.formatSize(event.total)}${
						event.progress !== undefined ? ` (${(event.progress * 100).toFixed(1)}%)` : ""
					}`
				: `${this.formatSize(event.loaded)} loaded`,
			event.rate !== undefined ? `Rate: ${this.formatSize(event.rate)}/s` : null,
			event.estimated !== undefined ? `Time left: ${event.estimated | 0}s` : null,
		]
			.filter(Boolean)
			.join("\n")
	}

	private async respond(video: string, quality: string) {
		await this.log("Downloading video...")

		if (!(await exists(resolve("videos", this.action.show)))) {
			await mkdir(resolve("videos", this.action.show), { recursive: true })
		}

		const stream = await axios
			.get<Stream>(video, {
				responseType: "stream",
				onDownloadProgress: progress => {
					if (Date.now() - this.lastUpdate < 1000) return

					this.lastUpdate = Date.now()
					this.log(this.formatProgress(progress, quality))
				},
			})
			.then(res => res.data)

		stream
			.pipe(
				createWriteStream(
					resolve("videos", this.action.show, (this.action.episode + "").padStart(2, "0") + ".mp4"),
				),
			)
			.on("finish", () => {
				this.log(
					`Quality: ${quality.toLowerCase()}\n` +
						[
							"https://dramaload.zectan.com",
							encodeURIComponent(this.action.show),
							(this.action.episode + "").padStart(2, "0") + ".mp4",
						].join("/"),
				)
			})
	}
}
