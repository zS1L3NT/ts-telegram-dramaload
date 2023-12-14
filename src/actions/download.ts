import axios from "axios"
import { CheerioAPI, load } from "cheerio"
import puppeteer from "puppeteer"

import { DownloadAction, RecaptchaAction } from "../app"
import { getCache, setCache, setRCLock } from "../cache"

const time = (ms: number) => new Promise(res => setTimeout(res, ms))
axios.defaults.headers.common["Accept-Encoding"] = "gzip"

export default async function download(
	action: DownloadAction,
	recaptcha: (image: Buffer, size: number) => Promise<string>,
	callback: (video: string) => void,
) {
	const slug =
		action.show.replaceAll(/[()]/g, "").replaceAll(" ", "-").toLowerCase() + "-episode-1"
	const html = await axios.get(`https://draplay2.pro/videos/${slug}`).then(r => r.data)
	const fullscreenUrl = ("http:" + load(html)("iframe").attr("src")).replace(
		"play.php",
		"download",
	)

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
	await page.goto(fullscreenUrl)
	await time(1000)

	let image = Buffer.from([])
	let popup$: CheerioAPI
	// eslint-disable-next-line no-constant-condition
	while (true) {
		console.log("[PPET] Trying to get a one-attempt recaptcha...")

		const checkiframe = await page.$('iframe[title="reCAPTCHA"]')
		const checkframe = await checkiframe?.contentFrame()
		if (await page.$(".mirror_link")) {
			console.log("[PPET] No recaptcha found! Fetching link...")
			const link = await page.$(".mirror_link:first-of-type a:last-of-type")
			const href = await link!.evaluate(e => e.getAttribute("href"))

			browser.close()
			callback(href)
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

		await page.goto(fullscreenUrl)
		await time(1000)
	}

	console.log("[TELE] Waiting for recaptcha completion...")
	const size = popup$("table tbody").children().length
	const messageId = await recaptcha(image, size)
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

	console.log("[PPET] Clicking squares... ", squares)
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

	const link = await page.waitForSelector(".mirror_link:first-of-type a:last-of-type")
	const href = await link!.evaluate(e => e.getAttribute("href"))

	browser.close()
	callback(href)
}
