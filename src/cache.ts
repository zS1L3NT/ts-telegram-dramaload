import { IAction } from "./app"

const PATH = process.cwd() + "/cache.json"

if (!(await Bun.file(PATH).exists())) {
	Bun.write(PATH, "{}")
}

let cache = (await Bun.file(PATH).json()) as Record<string, IAction[]>
let rclock: string | null = null

export const getCache = async <T extends IAction>(key: string): Promise<T[] | null> => {
	cache = await Bun.file(PATH).json()
	return (cache[key] as T[]) ?? null
}

export const setCache = async (key: string, value: IAction[]) => {
	cache[key] = value
	await Bun.write(PATH, JSON.stringify(cache))
}

export const getRCLock = () => rclock

export const setRCLock = (_rclock: string | null) => (rclock = _rclock)
