import TelegramBot from "node-telegram-bot-api"

export default abstract class Handler<T> {
	protected responseId = -1
	abstract start(): Promise<void>

	constructor(
		protected readonly bot: TelegramBot,
		protected readonly chatId: number,
		protected readonly messageId: number,
		protected readonly data: T,
		protected readonly metadata: string,
	) {}

	async setup(message: string) {
		this.responseId = await this.bot
			.sendMessage(this.chatId, this.metadata + message, {
				parse_mode: "Markdown",
				reply_markup: {
					inline_keyboard: [
						[
							{
								text: "Stop",
								callback_data: `${this.chatId},${this.responseId}`,
							},
						],
					],
				},
			})
			.then(m => m.message_id)
		return this
	}

	protected async log(message: string, final = false) {
		await this.bot.editMessageText(this.metadata.slice(0, final ? -1 : undefined) + message, {
			chat_id: this.chatId,
			message_id: this.responseId,
			parse_mode: "Markdown",
			reply_markup: final
				? undefined
				: {
						inline_keyboard: [
							[
								{
									text: "Stop",
									callback_data: `${this.chatId},${this.responseId}`,
								},
							],
						],
					},
		})
	}
}
