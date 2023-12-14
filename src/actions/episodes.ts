import axios from "axios"
import { load } from "cheerio"
import { InlineKeyboardButton, SendPhotoOptions } from "node-telegram-bot-api"

import { Action, EpisodesAction } from "../app"
import { setCache } from "../cache"

export default async (
	action: EpisodesAction,
	messageId: string,
	callback: (image: string, options: SendPhotoOptions) => void,
) => {
	const slug =
		action.show.replaceAll(/[()]/g, "").replaceAll(" ", "-").toLowerCase() + "-episode-1"
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
						}) satisfies Action,
				)
				.sort((a, b) => a.episode - b.episode),
		),
	]

	await setCache(messageId, episodes)
	callback(action.image, {
		caption: `Here are the episodes for "${action.show}"`,
		reply_markup: {
			inline_keyboard: episodes.map((s, i) => [
				{
					text: `Episode ${s.episode}`,
					callback_data: `${messageId},${i}`,
				} satisfies InlineKeyboardButton,
			]),
		},
	})
}
