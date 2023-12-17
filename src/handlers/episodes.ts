import axios from "axios"
import { load } from "cheerio"
import { InlineKeyboardButton } from "node-telegram-bot-api"

import { caches, EpisodesCache } from "../db"
import Handler from "./handler"

export default class EpisodesHandler extends Handler<EpisodesCache["actions"][number]> {
	override async start() {
		const slug =
			this.data.show
				.replaceAll(/[^a-zA-Z0-9\s]/g, "")
				.replaceAll(" ", "-")
				.toLowerCase() + "-episode-1"
		const html = await axios.get("https://draplay2.pro/videos/" + slug)

		const episodes = [
			...new Set(
				[...load(html.data)("ul.listing.items.lists > li.video-block")]
					.map(r => load(r)(".name").text().trim())
					.map(name => ({
						show: name.split(" ").slice(0, -2).join(" "),
						episode: +name.split(" ").at(-1)!,
					}))
					.sort((a, b) => a.episode - b.episode),
			),
		]

		await caches.findOne({ chatId: this.chatId, messageId: this.messageId, type: "download", actions: episodes })
		await this.bot.deleteMessage(this.chatId, this.responseId)
		await this.bot.sendPhoto(
			this.chatId,
			this.data.image,
			{
				caption: `*${this.data.show}*`,
				reply_markup: {
					inline_keyboard: episodes.map((s, i) => [
						{
							text: `Episode ${s.episode}`,
							callback_data: `${this.chatId},${this.messageId},${i}`,
						} satisfies InlineKeyboardButton,
					]),
				},
				parse_mode: "Markdown",
			},
			{
				filename: this.data.show + ".jpg",
				contentType: "image/jpeg",
			},
		)
	}
}
