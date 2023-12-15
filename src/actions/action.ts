import TelegramBot from "node-telegram-bot-api"

import { Action as ActionType } from "../app"

export default abstract class Action<T extends ActionType> {
	protected messageId = ""
	abstract start(): Promise<void>

	constructor(
		protected readonly bot: TelegramBot,
		protected readonly chatId: string,
		protected readonly cacheKey: string,
		protected readonly action: T,
		protected readonly metadata: string,
	) {}

	async setup(message: string) {
		this.messageId = await this.bot
			.sendMessage(this.chatId, this.metadata + message, { parse_mode: "Markdown" })
			.then(m => m.message_id + "")
		return this
	}

	protected async log(message: string) {
		await this.bot.editMessageText(this.metadata + message, {
			chat_id: this.chatId,
			message_id: +this.messageId,
			parse_mode: "Markdown",
		})
	}
}
