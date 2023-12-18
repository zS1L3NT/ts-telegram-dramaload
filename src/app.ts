import axios from "axios"
import express from "express"
import TelegramBot from "node-telegram-bot-api"

import { Cache, caches, DownloadCache, EpisodesCache, sessions, users } from "./db"
import DownloadHandler from "./handlers/download"
import EpisodesHandler from "./handlers/episodes"
import SearchHandler from "./handlers/search"

axios.defaults.headers.common["Accept-Encoding"] = "gzip"
const bot = new TelegramBot(Bun.env.TELEGRAM_API_KEY, { polling: true })

const isAuthenticated = async (username?: string) => {
	if (!username) return false
	return !!(await users.findOne({ username }))
}

bot.onText(/^\/start/, async message => {
	if (!(await isAuthenticated(message.from?.username))) {
		bot.sendMessage(message.chat.id, "You aren't authorized to use this bot.")
		return
	}

	if (message.chat.type !== "private") {
		bot.sendMessage(message.chat.id, "I only work in private chats, so please message me directly.")
	} else {
		bot.sendMessage(
			message.chat.id,
			[
				"Welcome to Dramaload!",
				"",
				"Search for a kdrama name with the following command:",
				"",
				"`/search <KDrama>`",
			].join("\n"),
			{ parse_mode: "Markdown" },
		)
	}
})

bot.onText(/^\/search/, async message => {
	if (!(await isAuthenticated(message.from?.username))) {
		bot.sendMessage(message.chat.id, "You aren't authorized to use this bot.")
		return
	}

	if (message.chat.type !== "private") {
		bot.sendMessage(message.chat.id, "I only work in private chats, so please message me directly.")
		return
	}

	const { text, message_id, chat } = message
	const search = text!.slice(8)

	new SearchHandler(bot, chat.id, message_id, search, "")
		.setup(`Searching for "${search}"...`)
		.then(search => search.start())
		.catch(e => {
			console.log("Error in search action:", e)
			bot.sendMessage(message.chat.id, "Error occured, please check logs.")
		})
})

bot.onText(/^\/auth/, async message => {
	if (message.from?.username !== "zS1L3NT") {
		bot.sendMessage(message.chat.id, "You aren't authorized to use this command.")
		return
	}

	const parts = message.text!.split(" ").slice(1)
	const mode = parts.shift()
	if (!mode || !["ls", "add", "remove"].includes(mode)) {
		bot.sendMessage(message.chat.id, "Please provide a valid mode. (ls, add, remove)")
		return
	}

	if (mode === "ls") {
		bot.sendMessage(
			message.chat.id,
			"*Users*\n" + (await users.find().toArray()).map(v => "@" + v.username).join("\n"),
			{ parse_mode: "Markdown" },
		)
		return
	}

	const user = parts.shift()
	if (!user || user[0] !== "@") {
		bot.sendMessage(message.chat.id, "Please provide a valid username.")
		return
	}

	if (mode === "add") {
		await users.insertOne({ username: user.slice(1) })
		bot.sendMessage(message.chat.id, `Authenticated ${user}`)
	} else {
		await users.deleteMany({ username: user.slice(1) })
		bot.sendMessage(message.chat.id, `Deauthenticated ${user}`)
	}
})

bot.on("callback_query", async ({ from, message, data }) => {
	if (!message || !data) return
	if (!(await isAuthenticated(from.username))) {
		bot.sendMessage(message.chat.id, "You aren't authorized to use this bot.")
		return
	}

	const [chatId, messageId, index] = data
		.split(",")
		.map(v => +v)
		.map((v, i) => (v === 0 && i === 1 ? message.message_id : v)) as [number, number, number]

	if (index === undefined) {
		await sessions.deleteOne({ chatId, messageId })
		return
	}

	const cache = await caches.findOne<Cache>({ chatId, messageId })
	if (!cache) {
		bot.deleteMessage(chatId, message.message_id)
		bot.sendMessage(chatId, "Cannot fetch metadata for that message, re-run the command.")
		return
	}

	if (cache.type === "recaptcha") {
		await caches.updateOne({ chatId: cache.chatId, messageId: cache.messageId }, { $push: { queued: index } })
	} else {
		const action = cache.actions[index]!
		const messageId = message.message_id

		switch (cache.type) {
			case "episodes":
				new EpisodesHandler(
					bot,
					chatId,
					messageId,
					action as EpisodesCache["actions"][number],
					`*${action.show}*\n\n`,
				)
					.setup("Fetching episodes...")
					.then(episodes => episodes.start())
					.catch(e => {
						console.log("Error in download action:", e)
						bot.sendMessage(chatId, "Error occured, please check logs.")
					})
				break
			case "download":
				new DownloadHandler(
					bot,
					chatId,
					messageId,
					action as DownloadCache["actions"][number],
					`*${action.show}*\n_Episode ${(action as DownloadCache["actions"][number]).episode}_\n\n`,
				)
					.setup("Fetching download url...")
					.then(download => download.start())
					.catch(e => {
						console.log("Error in download action:", e)
						bot.sendMessage(chatId, "Error occured, please check logs.")
					})
		}
	}
})

const PORT = 9844
const app = express()

app.use(express.static("videos"))
app.listen(PORT, () => console.log(`Serving files on port ${PORT}`))
