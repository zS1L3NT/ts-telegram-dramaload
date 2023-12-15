import axios from "axios"
import express from "express"
import TelegramBot from "node-telegram-bot-api"

import Download from "./actions/download"
import episodes from "./actions/episodes"
import search from "./actions/search"
import { getCache, getRCLock, setCache, setRCLock } from "./cache"

export type EpisodesAction = { type: "Episodes"; image: string; show: string }
export type DownloadAction = { type: "Download"; show: string; episode: number }
export type RecaptchaAction = { type: "Recaptcha"; squares: number[] | null; date: number }
export type Action = EpisodesAction | DownloadAction | RecaptchaAction

axios.defaults.headers.common["Accept-Encoding"] = "gzip"
const bot = new TelegramBot(Bun.env.TELEGRAM_API_KEY, { polling: true })

bot.onText(/^.*$/, async message => {
	const lock = getRCLock()
	if (!lock) return

	await bot.deleteMessage(message.chat.id, message.message_id)

	if (!message.text?.replaceAll(" ", "").match(/((\d+,)+)?\d+/)) {
		bot.sendMessage(message.chat.id, "Invalid input! Input must be comma seperated numbers")
		return
	}

	setRCLock(null)
	await setCache(lock, [
		{
			...((await getCache(lock))![0]! as RecaptchaAction),
			squares: message.text.split(",").map(v => +v - 1),
		},
	])
})

bot.onText(/^\/start$/, message => {
	bot.sendMessage(
		message.chat.id,
		[
			"Welcome to Dramaload!",
			"Search for a kdrama name with the following command:",
			"`/search <KDrama>`",
		].join("\n\n"),
		{ parse_mode: "Markdown" },
	)
})

bot.onText(/^\/search (.*)$/, async ({ text, message_id, chat }) => {
	search(text!.slice(8), message_id + "", (message, options) =>
		bot.sendMessage(chat.id, message, options),
	)
})

bot.on("callback_query", async ({ message, data }) => {
	if (!message || !data) return

	const [id, i] = data.split(",")
	const action = (await getCache(id + ""))?.[+i!]
	if (!action) return

	const chatId = message.chat.id + ""
	const messageId = message.message_id + ""
	switch (action.type) {
		case "Episodes":
			episodes(action, message.message_id + "", (image, options) =>
				bot.sendPhoto(chatId, image, options, {
					filename: action.show + ".jpg",
					contentType: "image/jpeg",
				}),
			)
			break
		case "Download":
			await new Download(
				bot,
				chatId,
				messageId,
				action,
				`*${action.show}*\n_Episode ${action.episode}_\n\n`,
			)
				.setup("Fetching download url...")
				.then(download => download.start())
	}
})

const PORT = 3000
const app = express()

app.use(express.static("videos"))
app.listen(PORT, () => console.log(`Serving files on port ${PORT}`))
