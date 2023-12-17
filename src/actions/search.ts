import axios from "axios"
import { load } from "cheerio"
import { InlineKeyboardButton } from "node-telegram-bot-api"

import { IEpisodesAction, setCache } from "../db"
import Action from "./action"

export default class SearchAction extends Action<string> {
	override async start() {
		await this.bot.deleteMessage(this.chatId, this.messageId)
		const html = await axios.get("https://draplay2.pro/search.html?keyword=" + encodeURIComponent(this.action))

		const shows = [
			...new Set(
				[...load(html.data)("ul.listing.items > li.video-block")]
					.map(r => load(r))
					.map(
						$ =>
							({
								type: "episodes",
								image: $(".picture > img").attr("src") as string,
								show: $(".name")
									.text()
									.trim()
									.match(/^(.+?) Episode \d+$/)?.[1] as string,
							}) satisfies IEpisodesAction,
					)
					.filter(s => !!s.image && !!s.show),
			),
		]

		await setCache(this.chatId, this.messageId, shows)
		await this.bot.editMessageText(`Search results for "${this.action}"`, {
			chat_id: this.chatId,
			message_id: this.responseId,
			reply_markup: {
				inline_keyboard: shows.map((s, i) => [
					{
						text: s.show,
						callback_data: `${this.messageId},${i}`,
					} satisfies InlineKeyboardButton,
				]),
			},
		})
	}
}
