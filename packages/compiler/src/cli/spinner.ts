import { LiveRegion, type Terminal } from "./terminal"
import type { Palette, Theme } from "./theme"

// NOTE: The spinner does not appear immediately. Most compilations finish in
// well under a tenth of a second, and a spinner that flashes for two frames
// reads as a glitch rather than as progress — so rendering only starts once a
// run has proven to be slow enough to be worth reporting on.
const RENDER_DELAY = 90
const FRAME_INTERVAL = 80
const ELAPSED_THRESHOLD = 1000

const unicodeFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const asciiFrames = ["-", "\\", "|", "/"]

export type TaskStatus = "waiting" | "active" | "success" | "error" | "warning"

export type Task = {
	id: string
	label: string
	status: TaskStatus
	detail?: string
	startedAt?: number
}

export type ProgressOptions = {
	terminal: Terminal
	theme: Theme
	palette: Palette
	enabled: boolean
	renderDelay?: number
}

export class Progress {
	private terminal: Terminal
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
		this.terminal = options.terminal
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

			// NOTE: The interval is unref'd so a spinner can never be the
			// reason the process stays alive after the work is done.
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

	// NOTE: Called before any permanent output is printed. Progress lives in a
	// region that is erased on the way out, so nothing it drew survives in
	// scrollback — the report is the only record of a finished run.
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

	// NOTE: Elapsed time only appears once a task has been running long enough
	// that the user might wonder whether it is stuck.
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
