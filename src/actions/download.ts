import axios, { AxiosProgressEvent } from "axios"
import { CheerioAPI, load } from "cheerio"
import { createWriteStream } from "fs"
import { exists, mkdir } from "fs/promises"
import TelegramBot from "node-telegram-bot-api"
import { resolve } from "path"
import puppeteer from "puppeteer"
import { Stream } from "stream"

import { DownloadAction, RecaptchaAction } from "../app"
import { getCache, setCache, setRCLock } from "../cache"

const time = (ms: number) => new Promise(res => setTimeout(res, ms))
axios.defaults.headers.common["Accept-Encoding"] = "gzip"

export default class Download {
	private lastUpdate = Date.now()

	constructor(
		private bot: TelegramBot,
		private chatId: string,
		private cacheKey: string,
		private action: DownloadAction,
	) {}

	async start() {
		const slug =
			this.action.show.replaceAll(/[()]/g, "").replaceAll(" ", "-").toLowerCase() +
			"-episode-" +
			this.action.episode
		const html = await axios.get(`https://draplay2.pro/videos/${slug}`).then(r => r.data)
		const fullscreenUrl = ("http:" + load(html)("iframe").attr("src")).replace(
			"play.php",
			"download",
		)

		console.log("[PPET] Starting browser...")
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

			console.log("[PPET] Trying to get a one-attempt recaptcha...")

			const checkiframe = await page.$('iframe[title="reCAPTCHA"]')
			const checkframe = await checkiframe?.contentFrame()
			if (await page.$(".mirror_link")) {
				console.log("[PPET] No recaptcha found! Fetching link...")
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
				console.log("[PPET] Got multi-attempt recaptcha! Refreshing...")
			} else if (!message) {
				console.log("[PPET] No message found. Trying again...")
			} else {
				await time(500)
				image = await popupiframe.screenshot()
				break
			}
		}

		console.log("[TELE] Waiting for recaptcha completion...")
		const size = popup$("table tbody").children().length
		const messageId = await this.bot
			.sendPhoto(
				this.chatId,
				image,
				{
					caption: [
						"Please type the square numbers that match the criteria in comma seperated form",
						`Numbers must be between 1 ~ ${Math.pow(
							size,
							2,
						)} since the image is ${size}x${size}. Example:`,
						"`1,3,4,9`\n`8,11,15,16`",
					].join("\n\n"),
					parse_mode: "Markdown",
				},
				{
					filename: this.action.show + ".jpg",
					contentType: "image/jpeg",
				},
			)
			.then(m => m.message_id + "")
		setRCLock(messageId)
		await setCache(messageId, [
			{
				type: "Recaptcha",
				squares: null,
				date: Date.now(),
			},
		])

		console.log("[TELE] Waiting for user response...")
		while (Date.now() - (await getCache<RecaptchaAction>(messageId))![0]!.date < 120_000) {
			if ((await getCache<RecaptchaAction>(messageId))![0]!.squares) break
			await time(3000)
		}

		const { squares } = (await getCache<RecaptchaAction>(messageId))![0]!
		if (!squares) {
			console.warn("[TELE] Recaptcha timed out")
			browser.close()
			setRCLock(null)
			return
		}

		console.log("[PPET] Clicking square indexes... ", squares)
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
		if ((await checkframe!.content()).includes("Recaptcha requires verification. ")) {
			console.warn("[TELE] Recaptcha failed")
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

	private responseText(progress?: AxiosProgressEvent | string) {
		return [
			...[`*${this.action.show}*`, `_Episode ${this.action.episode}_`, ""],
			...(progress
				? typeof progress === "object"
					? ([
							progress.total !== undefined
								? `${this.formatSize(progress.loaded)} / ${this.formatSize(
										progress.total,
									)}${
										progress.progress !== undefined
											? ` (${(progress.progress * 100).toFixed(1)}%)`
											: ""
									}`
								: `${this.formatSize(progress.loaded)} loaded`,
							progress.rate !== undefined
								? `Rate: ${this.formatSize(progress.rate)}/s`
								: null,
							progress.estimated !== undefined
								? `Time left: ${progress.estimated | 0}s`
								: null,
						].filter(Boolean) as string[])
					: [progress]
				: ["Loading video..."]),
		].join("\n")
	}

	private async respond(video: string) {
		const messageId = await this.bot
			.sendMessage(this.chatId, this.responseText(), { parse_mode: "Markdown" })
			.then(m => m.message_id)

		console.log("[TBOT] Downloading video...")

		if (!(await exists(resolve("videos", this.action.show)))) {
			await mkdir(resolve("videos", this.action.show), { recursive: true })
		}

		const stream = await axios
			.get<Stream>(video, {
				responseType: "stream",
				onDownloadProgress: progress => {
					if (Date.now() - this.lastUpdate < 1000) return

					this.lastUpdate = Date.now()
					this.bot.editMessageText(this.responseText(progress), {
						message_id: messageId,
						chat_id: this.chatId,
						parse_mode: "Markdown",
					})
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
				this.bot.editMessageText(
					this.responseText(
						[
							"https://dramaload.zectan.com",
							encodeURIComponent(this.action.show),
							(this.action.episode + "").padStart(2, "0") + ".mp4",
						].join("/"),
					),
					{
						message_id: messageId,
						chat_id: this.chatId,
						parse_mode: "Markdown",
					},
				)
			})
	}
}
