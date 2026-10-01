import { LiveRegion, type Terminal } from "./terminal"
import type { Palette, Theme } from "./theme"

// The spinner appears only once a run proves slow, since one that flashes for two
// frames reads as a glitch.
const RENDER_DELAY = 90
const FRAME_INTERVAL = 80
const ELAPSED_THRESHOLD = 1000

const unicodeFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const asciiFrames = ["-", "\\", "|", "/"]

type TaskStatus = "waiting" | "active" | "success" | "error" | "warning"

export type Task = {
	id: string
	label: string
	status: TaskStatus
	detail?: string
	startedAt?: number
}

type ProgressOptions = {
	terminal: Terminal
	theme: Theme
	palette: Palette
	enabled: boolean
	renderDelay?: number
}

export class Progress {
	private theme: Theme
	private palette: Palette
	private region: LiveRegion
	private enabled: boolean
	private renderDelay: number
	private tasks: Array<Task> = []
	private header: string | null = null
	private frame = 0
	private timer: ReturnType<typeof setInterval> | null = null
	private delayTimer: ReturnType<typeof setTimeout> | null = null
	private visible = false

	constructor(options: ProgressOptions) {
		this.theme = options.theme
		this.palette = options.palette
		this.region = new LiveRegion(options.terminal)
		this.enabled = options.enabled && options.terminal.isInteractive
		this.renderDelay = options.renderDelay ?? RENDER_DELAY
	}

	start(tasks: Array<Task>, header: string | null = null): void {
		this.tasks = tasks
		this.header = header

		if (!this.enabled || this.delayTimer !== null || this.visible) {
			return
		}

		this.delayTimer = setTimeout(() => {
			this.delayTimer = null
			this.visible = true
			this.draw()

			// Unref'd, so a spinner never keeps the process alive.
			this.timer = setInterval(() => {
				this.frame += 1
				this.draw()
			}, FRAME_INTERVAL)

			this.timer.unref?.()
		}, this.renderDelay)

		this.delayTimer.unref?.()
	}

	update(id: string, changes: Partial<Task>): void {
		let task = this.tasks.find((candidate) => candidate.id === id)

		if (task === undefined) {
			return
		}

		Object.assign(task, changes)

		if (changes.status === "active" && task.startedAt === undefined) {
			task.startedAt = performance.now()
		}

		this.draw()
	}

	// Called before any permanent output, so no progress frame survives in
	// scrollback.
	stop(): void {
		if (this.delayTimer !== null) {
			clearTimeout(this.delayTimer)
			this.delayTimer = null
		}

		if (this.timer !== null) {
			clearInterval(this.timer)
			this.timer = null
		}

		this.region.clear()
		this.visible = false
	}

	private draw(): void {
		if (!this.visible) {
			return
		}

		let lines: Array<string> = []

		if (this.header !== null) {
			lines.push(this.header)
		}

		for (let task of this.tasks) {
			lines.push(this.renderTask(task))
		}

		this.region.render(lines)
	}

	private renderTask(task: Task): string {
		let { palette, theme } = this
		let indicator: string
		let label: string

		switch (task.status) {
			case "waiting":
				indicator = palette.faint(theme.symbols.pending)
				label = palette.faint(task.label)
				break
			case "active":
				indicator = palette.accent(this.currentFrame())
				label = task.label
				break
			case "success":
				indicator = palette.success(theme.symbols.success)
				label = palette.muted(task.label)
				break
			case "warning":
				indicator = palette.warning(theme.symbols.warning)
				label = palette.muted(task.label)
				break
			case "error":
				indicator = palette.error(theme.symbols.error)
				label = palette.muted(task.label)
				break
		}

		let line = `  ${indicator} ${label}`

		if (task.detail !== undefined) {
			line += ` ${palette.muted(task.detail)}`
		}

		let elapsed = this.elapsedFor(task)

		if (elapsed !== null) {
			line += ` ${palette.faint(elapsed)}`
		}

		return line
	}

	// Elapsed time appears only once a task runs long enough to look stuck.
	private elapsedFor(task: Task): string | null {
		if (task.status !== "active" || task.startedAt === undefined) {
			return null
		}

		let elapsed = performance.now() - task.startedAt

		if (elapsed < ELAPSED_THRESHOLD) {
			return null
		}

		return `${(elapsed / 1000).toFixed(1)}s`
	}

	private currentFrame(): string {
		let frames = this.theme.unicode ? unicodeFrames : asciiFrames

		return frames[this.frame % frames.length]
	}
}
