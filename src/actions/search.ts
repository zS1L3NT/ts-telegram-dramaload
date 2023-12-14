import axios from "axios"
import { load } from "cheerio"
import { InlineKeyboardButton, SendMessageOptions } from "node-telegram-bot-api"

import { Action } from "../app"
import { setCache } from "../cache"

export default async (
	show: string,
	messageId: string,
	callback: (message: string, options: SendMessageOptions) => void,
) => {
	const html = await axios.get(
		"https://draplay2.pro/search.html?keyword=" + encodeURIComponent(show),
	)

	const shows = [
		...new Set(
			[...load(html.data)("ul.listing.items > li.video-block")]
				.map(r => load(r))
				.map(
					$ =>
						({
							type: "Episodes",
							image: $(".picture > img").attr("src") as string,
							show: $(".name")
								.text()
								.trim()
								.match(/^(.+?) Episode \d+$/)?.[1] as string,
						}) satisfies Action,
				)
				.filter(s => !!s.image && !!s.show),
		),
	]

	await setCache(messageId, shows)
	callback("Here are the shows that matched the search result:", {
		reply_markup: {
			inline_keyboard: shows.map((s, i) => [
				{
					text: s.show,
					callback_data: `${messageId},${i}`,
				} satisfies InlineKeyboardButton,
			]),
		},
	})
}
