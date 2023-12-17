import axios from "axios"
import { load } from "cheerio"
import { InlineKeyboardButton } from "node-telegram-bot-api"

import { caches } from "../db"
import Handler from "./handler"

export default class SearchAction extends Handler<string> {
	override async start() {
		await this.bot.deleteMessage(this.chatId, this.messageId)
		const html = await axios.get("https://draplay2.pro/search.html?keyword=" + encodeURIComponent(this.data))

		const shows = [
			...new Set(
				[...load(html.data)("ul.listing.items > li.video-block")]
					.map(r => load(r))
					.map($ => ({
						image: $(".picture > img").attr("src") as string,
						show: $(".name")
							.text()
							.trim()
							.match(/^(.+?) Episode \d+$/)?.[1] as string,
					}))
					.filter(s => !!s.image && !!s.show),
			),
		]

		await caches.insertOne({ chatId: this.chatId, messageId: this.messageId, type: "episodes", actions: shows })
		await this.bot.editMessageText(`Search results for "${this.data}"`, {
			chat_id: this.chatId,
			message_id: this.responseId,
			reply_markup: {
				inline_keyboard: shows.map((s, i) => [
					{
						text: s.show,
						callback_data: `${this.chatId},${this.messageId},${i}`,
					} satisfies InlineKeyboardButton,
				]),
			},
		})
	}
}
