import TelegramBot from "node-telegram-bot-api"

import { IAction } from "../db"

export default abstract class Action<T extends IAction | any = any> {
	protected responseId = -1
	abstract start(): Promise<void>

	constructor(
		protected readonly bot: TelegramBot,
		protected readonly chatId: number,
		protected readonly messageId: number,
		protected readonly action: T,
		protected readonly metadata: string,
	) {}

	async setup(message: string) {
		this.responseId = await this.bot
			.sendMessage(this.chatId, this.metadata + message, { parse_mode: "Markdown" })
			.then(m => m.message_id)
		return this
	}

	protected async log(message: string) {
		await this.bot.editMessageText(this.metadata + message, {
			chat_id: this.chatId,
			message_id: this.responseId,
			parse_mode: "Markdown",
		})
	}
}
