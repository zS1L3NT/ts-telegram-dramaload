import axios from "axios"
import { load } from "cheerio"
import { InlineKeyboardButton } from "node-telegram-bot-api"

import { IAction, IEpisodesAction } from "../app"
import { setCache } from "../cache"
import Action from "./action"

export default class EpisodesAction extends Action<IEpisodesAction> {
	override async start() {
		const slug =
			this.action.show.replaceAll(/[()]/g, "").replaceAll(" ", "-").toLowerCase() +
			"-episode-1"
		const html = await axios.get("https://draplay2.pro/videos/" + slug)

		const episodes = [
			...new Set(
				[...load(html.data)("ul.listing.items.lists > li.video-block")]
					.map(r => load(r)(".name").text().trim())
					.map(
						name =>
							({
								type: "Download",
								show: name.split(" ").slice(0, -2).join(" "),
								episode: +name.split(" ").at(-1)!,
							}) satisfies IAction,
					)
					.sort((a, b) => a.episode - b.episode),
			),
		]

		await setCache(this.cacheKey, episodes)
		await this.bot.deleteMessage(this.chatId, +this.messageId)
		await this.bot.sendPhoto(
			this.chatId,
			this.action.image,
			{
				caption: `*${this.action.show}*`,
				reply_markup: {
					inline_keyboard: episodes.map((s, i) => [
						{
							text: `Episode ${s.episode}`,
							callback_data: `${this.cacheKey},${i}`,
						} satisfies InlineKeyboardButton,
					]),
				},
				parse_mode: "Markdown",
			},
			{
				filename: this.action.show + ".jpg",
				contentType: "image/jpeg",
			},
		)
	}
}
