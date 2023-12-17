import { MongoClient } from "mongodb"

export type EpisodesCache = {
	type: "episodes"
	chatId: number
	messageId: number
	actions: { image: string; show: string }[]
}

export type DownloadCache = {
	type: "download"
	chatId: number
	messageId: number
	actions: { show: string; episode: number }[]
}

export type RecaptchaCache = {
	type: "recaptcha"
	chatId: number
	messageId: number
	squares: number[]
	submitted: boolean
	date: number
}

export type Cache = EpisodesCache | DownloadCache | RecaptchaCache

type Session = {
	chatId: number
	messageId: number
}

type User = {
	username: string
}

const client = new MongoClient(process.env.MONGODB_URI)
const database = client.db("dramaload")
export const caches = database.collection<Cache>("caches")
export const sessions = database.collection<Session>("sessions")
export const users = database.collection<User>("users")

await sessions.deleteMany({})
