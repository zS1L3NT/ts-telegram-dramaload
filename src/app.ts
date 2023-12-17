import axios from "axios"
import express from "express"
import TelegramBot from "node-telegram-bot-api"

import DownloadAction from "./actions/download"
import EpisodesAction from "./actions/episodes"
import SearchAction from "./actions/search"
import { getCache, getRCLock, setCache, setRCLock } from "./cache"

export type IEpisodesAction = { type: "Episodes"; image: string; show: string }
export type IDownloadAction = { type: "Download"; show: string; episode: number }
export type IRecaptchaAction = { type: "Recaptcha"; squares: number[] | null; date: number }
export type IAction = IEpisodesAction | IDownloadAction | IRecaptchaAction

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
			...((await getCache(lock))![0]! as IRecaptchaAction),
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

bot.onText(/^\/search (.*)$/, async message => {
	const { text, message_id, chat } = message
	const search = text!.slice(8)

	new SearchAction(bot, chat.id, message_id, search, "")
		.setup(`Searching for "${search}"...`)
		.then(search => search.start())
		.catch(e => {
			console.log("Error in search action:", { error: e })
			bot.sendMessage(chat.id, "Error occured, please check logs.")
		})
})

bot.on("callback_query", async ({ message, data }) => {
	if (!message || !data) return

	const [id, i] = data.split(",")
	const action = (await getCache(+id!))?.[+i!]
	if (!action) return

	const chatId = message.chat.id
	const messageId = message.message_id
	switch (action.type) {
		case "Episodes":
			new EpisodesAction(bot, chatId, messageId, action, `*${action.show}*\n\n`)
				.setup("Fetching episodes...")
				.then(episodes => episodes.start())
				.catch(e => {
					console.log("Error in download action:", { error: e, action, message, data })
					bot.sendMessage(chatId, "Error occured, please check logs.")
				})
			break
		case "Download":
			new DownloadAction(
				bot,
				chatId,
				messageId,
				action,
				`*${action.show}*\n_Episode ${action.episode}_\n\n`,
			)
				.setup("Fetching download url...")
				.then(download => download.start())
				.catch(e => {
					console.log("Error in download action:", e)
					bot.sendMessage(chatId, "Error occured, please check logs.")
				})
	}
})

const PORT = 9844
const app = express()

app.use(express.static("videos"))
app.listen(PORT, () => console.log(`Serving files on port ${PORT}`))
