import axios, { AxiosProgressEvent } from "axios"
import { CheerioAPI, load } from "cheerio"
import { createWriteStream } from "fs"
import { exists, mkdir } from "fs/promises"
import { resolve } from "path"
import puppeteer from "puppeteer"
import { Stream } from "stream"

import { IDownloadAction, IRecaptchaAction } from "../app"
import { getCache, setCache, setRCLock } from "../cache"
import Action from "./action"

const time = (ms: number) => new Promise(res => setTimeout(res, ms))

export default class DownloadAction extends Action<IDownloadAction> {
	private lastUpdate = Date.now()

	override async start() {
		const slug =
			this.action.show.replaceAll(/[()]/g, "").replaceAll(" ", "-").toLowerCase() +
			"-episode-" +
			this.action.episode
		const html = await axios.get(`https://draplay2.pro/videos/${slug}`).then(r => r.data)
		const fullscreenUrl = ("http:" + load(html)("iframe").attr("src")).replace(
			"play.php",
			"download",
		)

		await this.log("Starting browser...")
		const browser = await puppeteer.launch({
			headless: "new",
			executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			args: [
				"--disable-web-security",
				"--disable-features=IsolateOrigins,site-per-process",
				"--start-maximised",
			],
			defaultViewport: { width: 1920, height: 1080 },
		})
		const page = (await browser.pages())[0]!

		let image = Buffer.from([])
		let popup$: CheerioAPI
		// eslint-disable-next-line no-constant-condition
		while (true) {
			await page.goto(fullscreenUrl)
			await time(1000)

			await this.log("Trying to get a one-attempt recaptcha...")

			const checkiframe = await page.$('iframe[title="reCAPTCHA"]')
			const checkframe = await checkiframe?.contentFrame()
			if (await page.$(".mirror_link")) {
				await this.log("No recaptcha found! Fetching link...")
				const link = await page.$(".mirror_link:first-of-type div:last-of-type a")
				const href = await link!.evaluate(e => e.getAttribute("href"))

				browser.close()
				await this.respond(href)
				return
			}

			// @ts-ignore
			// prettier-ignore
			await checkframe.evaluate(() => document.querySelector(".recaptcha-checkbox-border").click())
			await time(1000)

			for (const page of (await browser.pages()).slice(1)) await page.close()

			// prettier-ignore
			const popupiframe = (await page.$('iframe[title="recaptcha challenge expires in two minutes"]',))!
			const popupframe = await popupiframe.contentFrame()
			popup$ = load(await popupframe.content())

			const message = popup$(".rc-imageselect-desc-no-canonical").text()
			if (message.includes("none left") || message.includes("skip")) {
				await this.log("Multi-attempt recaptcha detected, refreshing...")
			} else if (!message) {
				await this.log("No message detected, refreshing...")
			} else {
				await time(500)
				image = await popupiframe.screenshot()
				break
			}
		}

		await this.log("Waiting for recaptcha completion...")
		const size = popup$("table tbody").children().length

		await this.log(
			[
				"Please type the square numbers that match the criteria in comma seperated form",
				`Numbers must be between 1 ~ ${Math.pow(
					size,
					2,
				)} since the image is ${size}x${size}. Example:`,
				"`1,3,4,9`\n`8,11,15,16`",
			].join("\n\n"),
		)
		const photoId = await this.bot
			.sendPhoto(
				this.chatId,
				image,
				{},
				{
					filename: this.action.show + ".jpg",
					contentType: "image/jpeg",
				},
			)
			.then(m => m.message_id)

		setRCLock(this.messageId)
		await setCache(this.messageId, [
			{
				type: "Recaptcha",
				squares: null,
				date: Date.now(),
			},
		])

		while (
			Date.now() - (await getCache<IRecaptchaAction>(this.messageId))![0]!.date <
			120_000
		) {
			if ((await getCache<IRecaptchaAction>(this.messageId))![0]!.squares) break
			await time(3000)
		}

		await this.bot.deleteMessage(this.chatId, photoId)

		const { squares } = (await getCache<IRecaptchaAction>(this.messageId))![0]!
		if (!squares) {
			await this.log("Recaptcha timed out")
			browser.close()
			setRCLock(null)
			return
		}

		await this.log("Clicking squares: " + squares.map(s => s + 1).join(", "))
		// prettier-ignore
		const popupiframe = (await page.$('iframe[title="recaptcha challenge expires in two minutes"]',))!
		const popupframe = await popupiframe.contentFrame()

		await popupframe.click(".rc-imageselect-challenge")
		await time(2000)
		for (const page of (await browser.pages()).slice(1)) await page.close()

		for (const number of squares) {
			await time(250)
			await popupframe.click(
				`table tr:nth-of-type(${((number / size) | 0) + 1}) td:nth-of-type(${
					(number % size) + 1
				})`,
			)
		}

		await popupframe.click("#recaptcha-verify-button")
		await time(1000)
		await page.click("#btn-submit")

		const checkiframe = await page.$('iframe[title="reCAPTCHA"]')
		const checkframe = await checkiframe?.contentFrame()
		if ((await checkframe!.content()).includes("Recaptcha requires verification.")) {
			await this.log("Recaptcha failed")
			browser.close()
			return
		}

		const link = await page.waitForSelector(".mirror_link:first-of-type div:last-of-type a")
		const href = await link!.evaluate(e => e.getAttribute("href"))

		browser.close()
		await this.respond(href)
	}

	private formatSize(size: number) {
		const i = size == 0 ? 0 : Math.floor(Math.log(size) / Math.log(1024))
		return (size / Math.pow(1024, i)).toFixed(2) + " " + ["B", "kB", "MB", "GB", "TB"][i]
	}

	private formatProgress(event: AxiosProgressEvent) {
		return [
			event.total !== undefined
				? `Progress: ${this.formatSize(event.loaded)} / ${this.formatSize(event.total)}${
						event.progress !== undefined
							? ` (${(event.progress * 100).toFixed(1)}%)`
							: ""
					}`
				: `${this.formatSize(event.loaded)} loaded`,
			event.rate !== undefined ? `Rate: ${this.formatSize(event.rate)}/s` : null,
			event.estimated !== undefined ? `Time left: ${event.estimated | 0}s` : null,
		]
			.filter(Boolean)
			.join("\n")
	}

	private async respond(video: string) {
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
					this.log(this.formatProgress(progress))
				},
			})
			.then(res => res.data)

		stream
			.pipe(
				createWriteStream(
					resolve(
						"videos",
						this.action.show,
						(this.action.episode + "").padStart(2, "0") + ".mp4",
					),
				),
			)
			.on("finish", () => {
				this.log(
					[
						"https://dramaload.zectan.com",
						encodeURIComponent(this.action.show),
						(this.action.episode + "").padStart(2, "0") + ".mp4",
					].join("/"),
				)
			})
	}
}
