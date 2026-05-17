import type { CanvasEvent, CanvasVisibilityRequest } from "@pi-chat/shared";

type CanvasEventListener = (event: CanvasEvent) => void;

interface CanvasSubscriber {
	browserSessionId?: string;
	listener: CanvasEventListener;
}

interface ReadyWaiter {
	afterEpochMs: number;
	browserSessionId: string;
	cardId: string;
	resolve: (ready: boolean) => void;
	timeoutHandle: NodeJS.Timeout;
}

function subscriberMatchesVisibilityTarget(
	subscriber: CanvasSubscriber,
	request: CanvasVisibilityRequest,
): boolean {
	if (!request.browserSessionId) {
		return true;
	}

	return subscriber.browserSessionId === request.browserSessionId;
}

export class CanvasEventBus {
	private readonly subscribersByUserId = new Map<string, Set<CanvasSubscriber>>();

	private readonly lastBrowserSessionIdByUserId = new Map<string, string>();

	private readonly lastReadyEpochByUserId = new Map<string, Map<string, number>>();

	private readonly readyWaitersByUserId = new Map<string, Set<ReadyWaiter>>();

	subscribe(userId: string, browserSessionId: string | undefined, listener: CanvasEventListener): () => void {
		const subscribers = this.subscribersByUserId.get(userId) ?? new Set<CanvasSubscriber>();
		this.subscribersByUserId.set(userId, subscribers);

		const subscriber: CanvasSubscriber = browserSessionId ? { browserSessionId, listener } : { listener };

		if (browserSessionId) {
			this.lastBrowserSessionIdByUserId.set(userId, browserSessionId);
		}

		subscribers.add(subscriber);
		return () => {
			subscribers.delete(subscriber);
			if (subscribers.size === 0) {
				this.subscribersByUserId.delete(userId);
			}
		};
	}

	publish(userId: string, event: CanvasEvent): void {
		const subscribers = this.subscribersByUserId.get(userId);
		if (!subscribers || subscribers.size === 0) {
			return;
		}

		if (event.type === "canvas.visibility.requested" && event.request.browserSessionId) {
			this.lastBrowserSessionIdByUserId.set(userId, event.request.browserSessionId);
		}

		for (const subscriber of subscribers) {
			if (event.type === "canvas.visibility.requested" && !subscriberMatchesVisibilityTarget(subscriber, event.request)) {
				continue;
			}

			subscriber.listener(event);
		}
	}

	getLastBrowserSessionId(userId: string): string | undefined {
		return this.lastBrowserSessionIdByUserId.get(userId);
	}

	waitForCardReady(
		userId: string,
		options: {
			cardId: string;
			browserSessionId: string;
			after: string;
			timeoutMs: number;
		},
	): Promise<boolean> {
		const readyKey = this.getReadyKey(options.cardId, options.browserSessionId);
		const lastReadyEpoch = this.lastReadyEpochByUserId.get(userId)?.get(readyKey);
		const afterEpochMs = Date.parse(options.after);

		if (lastReadyEpoch !== undefined && Number.isFinite(afterEpochMs) && lastReadyEpoch >= afterEpochMs) {
			return Promise.resolve(true);
		}

		return new Promise<boolean>((resolve) => {
			const waiters = this.readyWaitersByUserId.get(userId) ?? new Set<ReadyWaiter>();
			this.readyWaitersByUserId.set(userId, waiters);

			const waiter: ReadyWaiter = {
				afterEpochMs,
				browserSessionId: options.browserSessionId,
				cardId: options.cardId,
				resolve: (ready) => {
					clearTimeout(waiter.timeoutHandle);
					waiters.delete(waiter);
					if (waiters.size === 0) {
						this.readyWaitersByUserId.delete(userId);
					}
					resolve(ready);
				},
				timeoutHandle: setTimeout(() => {
					waiter.resolve(false);
				}, options.timeoutMs),
			};

			waiters.add(waiter);
		});
	}

	notifyCardReady(userId: string, cardId: string, browserSessionId: string | undefined, readyAt: string): void {
		if (browserSessionId) {
			this.lastBrowserSessionIdByUserId.set(userId, browserSessionId);
			const readyKey = this.getReadyKey(cardId, browserSessionId);
			const readyEvents = this.lastReadyEpochByUserId.get(userId) ?? new Map<string, number>();
			readyEvents.set(readyKey, Date.parse(readyAt));
			this.lastReadyEpochByUserId.set(userId, readyEvents);
		}

		const waiters = this.readyWaitersByUserId.get(userId);
		if (!waiters || !browserSessionId) {
			return;
		}

		for (const waiter of [...waiters]) {
			if (waiter.cardId !== cardId || waiter.browserSessionId !== browserSessionId) {
				continue;
			}

			const readyEpoch = Date.parse(readyAt);
			if (Number.isFinite(waiter.afterEpochMs) && Number.isFinite(readyEpoch) && readyEpoch < waiter.afterEpochMs) {
				continue;
			}

			waiter.resolve(true);
		}
	}

	requestVisibility(
		userId: string,
		visibility: CanvasVisibilityRequest["visibility"],
		browserSessionId = this.getLastBrowserSessionId(userId),
	): CanvasEvent {
		const request: CanvasVisibilityRequest = browserSessionId
			? {
					visibility,
					browserSessionId,
					requestedAt: new Date().toISOString(),
				}
			: {
					visibility,
					requestedAt: new Date().toISOString(),
				};

		const event: CanvasEvent = {
			type: "canvas.visibility.requested",
			request,
		};

		this.publish(userId, event);
		return event;
	}

	private getReadyKey(cardId: string, browserSessionId: string): string {
		return `${cardId}::${browserSessionId}`;
	}
}
