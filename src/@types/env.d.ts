declare module "bun" {
	interface Env {
		readonly TELEGRAM_API_KEY: string
		readonly MONGODB_URI: string
	}
}