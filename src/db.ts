import { MongoClient } from "mongodb"

export type IEpisodesAction = { type: "episodes"; image: string; show: string }
export type IDownloadAction = { type: "download"; show: string; episode: number }
export type IRecaptchaAction = { type: "recaptcha"; squares: number[] | null; date: number }
export type IAction = IEpisodesAction | IDownloadAction | IRecaptchaAction

type Message = {
	chatId: number
	messageId: number
	actions: IAction[]
}

type Session = {
	chatId: number
	recaptcha: number | null
}

type User = {
	username: string
}

const client = new MongoClient(process.env.MONGODB_URI)
const database = client.db("dramaload")
const messages = database.collection<Message>("messages")
const sessions = database.collection<Session>("sessions")
const users = database.collection<User>("users")

await sessions.deleteMany({})

export const getCache = async <T extends IAction>(chatId: number, messageId: number): Promise<T[] | null> => {
	return await messages.findOne({ chatId, messageId }).then(m => (m ? (m.actions as T[]) : null))
}

export const setCache = async (chatId: number, messageId: number, actions: IAction[]) => {
	await messages.updateOne({ chatId, messageId }, { $set: { actions } }, { upsert: true })
}

export const getSession = async (chatId: number): Promise<Session | null> => {
	return await sessions.findOne({ chatId })
}

export const setSession = async (chatId: number, session: Omit<Session, "chatId"> | null) => {
	if (session) {
		await sessions.updateOne({ chatId }, { $set: session }, { upsert: true })
	} else {
		await sessions.deleteOne({ chatId })
	}
}

export const listAuthenticated = async () => {
	return (await users.find().toArray()).map(v => v.username)
}

export const isAuthenticated = async (username?: string) => {
	if (!username) return false
	return !!(await users.findOne({ username }))
}

export const authenticate = async (username: string) => {
	await users.updateOne({ username }, { $set: { username } }, { upsert: true })
}

export const deauthenticate = async (username: string) => {
	await users.deleteMany({ username })
}
