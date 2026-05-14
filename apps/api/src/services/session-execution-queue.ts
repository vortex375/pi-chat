export class SessionExecutionQueue {
	private readonly queues = new Map<string, Promise<unknown>>();

	async run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = previous.then(() => current);
		this.queues.set(sessionId, queued);

		await previous;

		try {
			return await task();
		} finally {
			release();
			if (this.queues.get(sessionId) === queued) {
				this.queues.delete(sessionId);
			}
		}
	}
}
