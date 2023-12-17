import axios from "axios"
import express from "express"
import TelegramBot from "node-telegram-bot-api"

import DownloadAction from "./actions/download"
import EpisodesAction from "./actions/episodes"
import SearchAction from "./actions/search"
import { getCache, getSession, IRecaptchaAction, setCache, setSession } from "./db"

axios.defaults.headers.common["Accept-Encoding"] = "gzip"
const bot = new TelegramBot(Bun.env.TELEGRAM_API_KEY, { polling: true })

bot.onText(/^.*$/, async message => {
	if (message.from?.username !== "zS1L3NT") {
		bot.sendMessage(message.chat.id, "I only answer to zS1L3NT.")
		return
	}

	const session = await getSession(message.chat.id)
	if (!session) return

	if (message.text?.toLowerCase() === "stop") {
		await Promise.all([bot.deleteMessage(message.chat.id, message.message_id), setSession(message.chat.id, null)])
	} else if (session.recaptcha) {
		await bot.deleteMessage(message.chat.id, message.message_id)

		if (!message.text?.replaceAll(" ", "").match(/((\d+,)+)?\d+/)) {
			bot.sendMessage(message.chat.id, "Invalid input! Input must be comma seperated numbers")
			return
		}

		await setSession(message.chat.id, { recaptcha: null })
		await setCache(message.chat.id, session.recaptcha, [
			{
				...((await getCache(message.chat.id, session.recaptcha))![0]! as IRecaptchaAction),
				squares: message.text.split(",").map(v => +v - 1),
			},
		])
	}
})

bot.onText(/^\/start$/, message => {
	if (message.from?.username !== "zS1L3NT") {
		bot.sendMessage(message.chat.id, "I only answer to zS1L3NT.")
		return
	}

	bot.sendMessage(
		message.chat.id,
		["Welcome to Dramaload!", "Search for a kdrama name with the following command:", "`/search <KDrama>`"].join(
			"\n\n",
		),
		{ parse_mode: "Markdown" },
	)
})

bot.onText(/^\/search (.*)$/, async message => {
	if (message.from?.username !== "zS1L3NT") {
		bot.sendMessage(message.chat.id, "I only answer to zS1L3NT.")
		return
	}

	const { text, message_id, chat } = message
	const search = text!.slice(8)

	new SearchAction(bot, chat.id, message_id, search, "")
		.setup(`Searching for "${search}"...`)
		.then(search => search.start())
		.catch(e => {
			console.log("Error in search action:", e)
			bot.sendMessage(message.chat.id, "Error occured, please check logs.")
		})
})

bot.on("callback_query", async ({ message, data }) => {
	if (!message || !data) return

	const [id, i] = data.split(",").map(v => +v) as [number, number]
	const action = (await getCache(message.chat.id, id))?.[i]
	if (!action) {
		bot.deleteMessage(message.chat.id, message.message_id)
		bot.sendMessage(message.chat.id, "Cannot fetch actions for that message, re-run the command.")
		return
	}

	const chatId = message.chat.id
	const messageId = message.message_id
	switch (action.type) {
		case "episodes":
			new EpisodesAction(bot, chatId, messageId, action, `*${action.show}*\n\n`)
				.setup("Fetching episodes...")
				.then(episodes => episodes.start())
				.catch(e => {
					console.log("Error in download action:", e)
					bot.sendMessage(chatId, "Error occured, please check logs.")
				})
			break
		case "download":
			new DownloadAction(bot, chatId, messageId, action, `*${action.show}*\n_Episode ${action.episode}_\n\n`)
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
