import * as ReactNamespace from "react";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as ReactJsxRuntime from "react/jsx-runtime";
import { startTransition, useEffect, useRef, useState } from "react";
import {
	getFallbackSessionTitle,
	type CanvasCard,
	type CanvasEvent,
	type CanvasSnapshot,
	type ChatMessage,
	type SessionDetail,
	type SessionSummary,
	type StreamEvent,
} from "@pi-chat/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	createSession,
	deleteSession,
	getCanvasSnapshot,
	getSession,
	listSessions,
	renameSession,
	streamCanvasEvents,
	streamSessionMessage,
} from "./api";
import { CanvasPanel } from "./components/CanvasPanel";

type LoadState = "idle" | "loading" | "ready" | "error";
type StreamPhase = "idle" | "connecting" | "streaming" | "done" | "error";

type StreamStatus = {
	phase: StreamPhase;
	label: string;
};

type SessionActivity = StreamStatus;

const EMPTY_SESSION_LABEL = "(no messages)";
const DONE_BADGE_TIMEOUT_MS = 2500;
const FOLLOW_UP_SESSION_REFRESH_DELAY_MS = 250;

function buildLocalMessage(
	role: "user" | "assistant",
	content: string,
	status: NonNullable<ChatMessage["status"]>,
): ChatMessage {
	const message: ChatMessage = {
		id: `local-${role}-${crypto.randomUUID()}`,
		role,
		content,
		createdAt: new Date().toISOString(),
		status,
	};

	return message;
}

function formatTime(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
		month: "short",
		day: "numeric",
	}).format(new Date(value));
}

function toSummary(detail: SessionDetail): SessionSummary {
	const summary: SessionSummary = {
		id: detail.id,
		displayName: detail.displayName,
		hasCustomName: detail.hasCustomName,
		firstMessage: detail.firstMessage,
		modifiedAt: detail.modifiedAt,
	};

	if (detail.name !== undefined) {
		summary.name = detail.name;
	}

	return summary;
}

function sortSessions(items: SessionSummary[]): SessionSummary[] {
	return [...items].sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function upsertSummary(items: SessionSummary[], detail: SessionDetail): SessionSummary[] {
	const summary = toSummary(detail);
	const next = items.filter((item) => item.id !== detail.id);
	return sortSessions([summary, ...next]);
}

function createEmptyCanvasSnapshot(): CanvasSnapshot {
	return {
		cards: [],
		diagnostics: {},
		generatedAt: new Date(0).toISOString(),
	};
}

function upsertCanvasCard(cards: CanvasCard[], nextCard: CanvasCard): CanvasCard[] {
	return [nextCard, ...cards.filter((card) => card.id !== nextCard.id)];
}

function replaceCanvasCard(cards: CanvasCard[], nextCard: CanvasCard): CanvasCard[] {
	const existingIndex = cards.findIndex((card) => card.id === nextCard.id);
	if (existingIndex === -1) {
		return [nextCard, ...cards];
	}

	return cards.map((card) => (card.id === nextCard.id ? nextCard : card));
}

function updateAssistantMessage(detail: SessionDetail, assistantId: string, updater: (message: ChatMessage) => ChatMessage): SessionDetail {
	return {
		...detail,
		messages: detail.messages.map((message) => (message.id === assistantId ? updater(message) : message)),
	};
}

function createOptimisticDetail(detail: SessionDetail, prompt: string): { assistantId: string; detail: SessionDetail } {
	const optimisticUser = buildLocalMessage("user", prompt, "complete");
	const optimisticAssistant = buildLocalMessage("assistant", "", "streaming");
	const displayName =
		detail.hasCustomName || detail.firstMessage !== EMPTY_SESSION_LABEL ? detail.displayName : getFallbackSessionTitle(prompt);

	return {
		assistantId: optimisticAssistant.id,
		detail: {
			...detail,
			displayName,
			firstMessage: detail.firstMessage === EMPTY_SESSION_LABEL ? prompt : detail.firstMessage,
			modifiedAt: optimisticUser.createdAt,
			messages: [...detail.messages, optimisticUser, optimisticAssistant],
		},
	};
}

function statusTone(phase: StreamPhase): string {
	if (phase === "error") {
		return "text-rose-300";
	}

	if (phase === "done") {
		return "text-emerald-300";
	}

	if (phase === "streaming" || phase === "connecting") {
		return "text-amber-200";
	}

	return "text-stone-400";
}

function hasLiveStream(activity: SessionActivity | undefined): boolean {
	return activity?.phase === "connecting" || activity?.phase === "streaming";
}

function sessionBadgeTone(phase: StreamPhase): string {
	if (phase === "error") {
		return "bg-rose-300";
	}

	if (phase === "done") {
		return "bg-emerald-300";
	}

	if (phase === "streaming" || phase === "connecting") {
		return "bg-amber-200";
	}

	return "bg-stone-500";
}

function confirmDeleteSession(displayName: string): boolean {
	return window.confirm(`Delete "${displayName}"? This cannot be undone.`);
}

function SessionSidebar(props: {
	sessions: SessionSummary[];
	selectedSessionId: string | null;
	isLoading: boolean;
	isCreating: boolean;
	deletingSessionId: string | null;
	activityBySessionId: Record<string, SessionActivity | undefined>;
	errorMessage: string | null;
	onCreateSession: () => void;
	onSelectSession: (sessionId: string) => void;
	onDeleteSession: (sessionId: string) => void;
}) {
	return (
		<aside className="flex max-h-[45dvh] w-full flex-col rounded-[1.75rem] border border-white/10 bg-[linear-gradient(180deg,rgba(31,24,20,0.96),rgba(17,14,12,0.98))] p-4 shadow-[0_30px_90px_rgba(0,0,0,0.35)] lg:max-h-none lg:max-w-[19rem]">
			<div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
				<div>
					<p className="text-xs uppercase tracking-[0.35em] text-amber-300/80">Pi Chat</p>
					<h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-50">Sessions</h1>
				</div>
				<button
					type="button"
					onClick={props.onCreateSession}
					disabled={props.isCreating}
					className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3.5 py-1.5 text-sm font-medium text-amber-100 transition hover:border-amber-200/50 hover:bg-amber-300/20 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{props.isCreating ? "Creating..." : "New session"}
				</button>
			</div>

			{props.errorMessage ? (
				<p className="mt-4 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
					{props.errorMessage}
				</p>
			) : null}

			<div className="mt-4 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
				{props.isLoading ? (
					<div className="space-y-3">
						{Array.from({ length: 4 }, (_, index) => (
							<div
								key={index}
								className="h-20 animate-pulse rounded-[1.5rem] border border-white/8 bg-white/5"
							/>
						))}
					</div>
				) : props.sessions.length === 0 ? (
					<div className="rounded-[1.75rem] border border-dashed border-white/12 bg-white/4 px-5 py-8 text-center text-sm leading-6 text-stone-400">
						Create the first session to start a workspace-backed conversation.
					</div>
				) : (
					props.sessions.map((session) => {
						const isSelected = session.id === props.selectedSessionId;
						const isDeleting = session.id === props.deletingSessionId;
						const activity = props.activityBySessionId[session.id];
						const isStreaming = hasLiveStream(activity);
						return (
							<div
								key={session.id}
								className={`flex items-start gap-3 rounded-[1.4rem] border px-3.5 py-3 transition ${
									isSelected
										? "border-amber-300/40 bg-amber-300/12 text-stone-50 shadow-[0_12px_40px_rgba(245,158,11,0.12)]"
										: "border-white/8 bg-white/4 text-stone-200 hover:border-white/14 hover:bg-white/7"
								}`}
							>
								<button
									type="button"
									onClick={() => props.onSelectSession(session.id)}
									className="min-w-0 flex-1 text-left"
								>
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0">
											<p className="line-clamp-2 text-sm font-medium leading-6">{session.displayName}</p>
											<p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-400">{session.firstMessage}</p>
										</div>
									</div>
								</button>
								<div className="flex shrink-0 flex-col items-end gap-2">
									<div className="flex items-center gap-2">
										{activity ? (
											<span
												title={activity.label}
												className={`h-2.5 w-2.5 rounded-full ${sessionBadgeTone(activity.phase)} ${hasLiveStream(activity) ? "animate-pulse" : ""}`}
											>
												<span className="sr-only">{activity.phase}</span>
											</span>
										) : null}
										<p className="text-[11px] uppercase tracking-[0.2em] text-stone-500">
											{formatTime(session.modifiedAt)}
										</p>
									</div>
									<button
										type="button"
										onClick={() => {
											if (!confirmDeleteSession(session.displayName)) {
												return;
											}

											props.onDeleteSession(session.id);
										}}
										disabled={isDeleting || isStreaming}
										aria-label={`Delete ${session.displayName}`}
										className="rounded-full border border-rose-400/25 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-rose-200 transition hover:border-rose-300/45 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
									>
										{isDeleting ? "Deleting..." : "Delete"}
									</button>
								</div>
							</div>
						);
					})
				)}
			</div>
		</aside>
	);
}

function EditableSessionTitle(props: {
	value: string;
	displayName: string;
	disabled: boolean;
	pending: boolean;
	isDeleting: boolean;
	errorMessage: string | null;
	onRename: (name: string) => Promise<void>;
	onDelete: () => Promise<void>;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(props.value || props.displayName);

	useEffect(() => {
		setDraft(props.value || props.displayName);
		setIsEditing(false);
	}, [props.displayName, props.value]);

	if (!isEditing) {
		return (
			<div>
				<div className="flex items-center gap-3">
					<h2 className="text-xl font-semibold tracking-tight text-stone-50 sm:text-2xl">{props.displayName}</h2>
					<button
						type="button"
						onClick={() => setIsEditing(true)}
						disabled={props.disabled}
						className="rounded-full border border-white/12 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-stone-300 transition hover:border-white/30 hover:text-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
					>
						Rename
					</button>
					<button
						type="button"
						onClick={() => {
							if (!confirmDeleteSession(props.displayName)) {
								return;
							}

							void props.onDelete().catch(() => {});
						}}
						disabled={props.disabled || props.pending || props.isDeleting}
						className="rounded-full border border-rose-400/25 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-rose-200 transition hover:border-rose-300/45 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{props.isDeleting ? "Deleting..." : "Delete"}
					</button>
				</div>
				{props.errorMessage ? <p className="mt-3 text-sm text-rose-300">{props.errorMessage}</p> : null}
			</div>
		);
	}

	return (
		<form
			className="flex flex-col gap-3 sm:flex-row sm:items-center"
			onSubmit={(event) => {
				event.preventDefault();
					void props
						.onRename(draft)
						.then(() => setIsEditing(false))
						.catch(() => {});
			}}
		>
			<input
				autoFocus
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				disabled={props.pending}
				className="w-full rounded-full border border-white/12 bg-black/20 px-4 py-3 text-base text-stone-50 outline-none transition focus:border-amber-300/60"
				placeholder="Session title"
			/>
			<div className="flex items-center gap-2">
				<button
					type="submit"
					disabled={props.pending}
					className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{props.pending ? "Saving..." : "Save"}
				</button>
				<button
					type="button"
					onClick={() => {
						setDraft(props.value || props.displayName);
						setIsEditing(false);
					}}
					disabled={props.pending}
					className="rounded-full border border-white/12 px-4 py-2 text-sm text-stone-300 transition hover:border-white/24 hover:text-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Cancel
				</button>
			</div>
			{props.errorMessage ? <p className="text-sm text-rose-300 sm:basis-full">{props.errorMessage}</p> : null}
		</form>
	);
}

function MarkdownMessage(props: { content: string; tone: "user" | "assistant" | "error" }) {
	const inlineCodeClassName =
		props.tone === "user"
			? "rounded bg-stone-950/12 px-1.5 py-0.5 text-[0.92em] text-stone-950"
			: props.tone === "error"
				? "rounded bg-black/20 px-1.5 py-0.5 text-[0.92em] text-rose-50"
				: "rounded bg-white/10 px-1.5 py-0.5 text-[0.92em] text-stone-50";
	const blockClassName =
		props.tone === "user"
			? "border border-stone-950/10 bg-stone-950/8"
			: props.tone === "error"
				? "border border-rose-300/20 bg-black/20"
				: "border border-white/10 bg-black/25";
	const quoteClassName =
		props.tone === "user"
			? "border-l-stone-950/30 text-stone-800"
			: props.tone === "error"
				? "border-l-rose-200/40 text-rose-100"
				: "border-l-amber-300/40 text-stone-300";
	const linkClassName = props.tone === "user" ? "text-stone-950 underline decoration-stone-950/40 underline-offset-4" : "text-amber-200 underline decoration-amber-200/40 underline-offset-4";

	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm]}
			components={{
				p: ({ node, ...rest }) => <p className="mt-3 first:mt-0" {...rest} />,
				ul: ({ node, ...rest }) => <ul className="mt-3 list-disc space-y-2 pl-5 first:mt-0" {...rest} />,
				ol: ({ node, ...rest }) => <ol className="mt-3 list-decimal space-y-2 pl-5 first:mt-0" {...rest} />,
				li: ({ node, ...rest }) => <li className="pl-1" {...rest} />,
				blockquote: ({ node, ...rest }) => <blockquote className={`mt-3 border-l-2 pl-4 italic first:mt-0 ${quoteClassName}`} {...rest} />,
				a: ({ node, ...rest }) => <a className={linkClassName} target="_blank" rel="noreferrer" {...rest} />,
				pre: ({ node, ...rest }) => <pre className={`mt-3 overflow-x-auto rounded-2xl p-4 first:mt-0 ${blockClassName}`} {...rest} />,
				code: ({ node, className, children, ...rest }) => {
					if (className) {
						return (
							<code className={`${className} block whitespace-pre text-[13px] leading-6`} {...rest}>
								{children}
							</code>
						);
					}

					return (
						<code className={inlineCodeClassName} {...rest}>
							{children}
						</code>
					);
				},
				hr: ({ node, ...rest }) => <hr className="my-4 border-white/10 first:mt-0" {...rest} />,
				table: ({ node, ...rest }) => <table className="mt-3 w-full border-collapse text-left first:mt-0" {...rest} />,
				th: ({ node, ...rest }) => <th className="border-b border-white/10 px-3 py-2 font-semibold" {...rest} />,
				td: ({ node, ...rest }) => <td className="border-b border-white/10 px-3 py-2 align-top" {...rest} />,
			}}
		>
			{props.content}
		</ReactMarkdown>
	);
}

function MessageBubble({ message }: { message: ChatMessage }) {
	const isUser = message.role === "user";
	const isStreaming = message.status === "streaming";
	const isError = message.status === "error";
	const messageTone = isUser ? "user" : isError ? "error" : "assistant";
	const messageContent = message.content || (isStreaming ? "Thinking..." : "");
	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[85%] rounded-[1.75rem] px-4 py-3 shadow-[0_14px_40px_rgba(0,0,0,0.18)] sm:max-w-[75%] ${
					isUser
						? "rounded-br-md bg-amber-300 text-stone-950"
						: isError
							? "rounded-bl-md border border-rose-400/30 bg-rose-500/10 text-rose-100"
							: "rounded-bl-md border border-white/10 bg-white/6 text-stone-100"
				}`}
			>
				<div className="text-sm leading-7 sm:text-[15px]">
					<MarkdownMessage content={messageContent} tone={messageTone} />
				</div>
				<div className={`mt-3 flex items-center justify-between gap-4 text-[11px] uppercase tracking-[0.22em] ${isUser ? "text-stone-700/80" : "text-stone-500"}`}>
					<span>{message.role}</span>
					<div className="flex items-center gap-2">
						{isStreaming ? <span className="h-2 w-2 rounded-full bg-amber-300 animate-pulse" /> : null}
						<span>{formatTime(message.createdAt)}</span>
					</div>
				</div>
			</div>
		</div>
	);
}

function Composer(props: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	disabled: boolean;
}) {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}

		textarea.style.height = "0px";
		const nextHeight = Math.min(textarea.scrollHeight, 192);
		textarea.style.height = `${Math.max(nextHeight, 44)}px`;
		textarea.style.overflowY = textarea.scrollHeight > 192 ? "auto" : "hidden";
	}, [props.value]);

	return (
		<div className="rounded-[1.35rem] border border-white/10 bg-black/20 p-2 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
			<textarea
				ref={textareaRef}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						props.onSubmit();
					}
				}}
				disabled={props.disabled}
				placeholder="Send a prompt into the workspace..."
				rows={1}
				className="w-full resize-none bg-transparent px-2.5 py-2 text-sm leading-6 text-stone-100 outline-none placeholder:text-stone-500"
			/>
			<div className="flex items-center justify-between gap-3 border-t border-white/8 px-2 py-1.5">
				<p className="text-[11px] uppercase tracking-[0.22em] text-stone-500">Enter to send, Shift+Enter for a new line</p>
				<button
					type="button"
					onClick={props.onSubmit}
					disabled={props.disabled || props.value.trim().length === 0}
					className="rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-45"
				>
					Send
				</button>
			</div>
		</div>
	);
}

export function App() {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [sessionsState, setSessionsState] = useState<LoadState>("loading");
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
	const [sessionDetailsById, setSessionDetailsById] = useState<Record<string, SessionDetail>>({});
	const [sessionActivityById, setSessionActivityById] = useState<Record<string, SessionActivity | undefined>>({});
	const [selectedSessionState, setSelectedSessionState] = useState<LoadState>("idle");
	const [composerValue, setComposerValue] = useState("");
	const [sidebarError, setSidebarError] = useState<string | null>(null);
	const [chatError, setChatError] = useState<string | null>(null);
	const [sessionActionError, setSessionActionError] = useState<string | null>(null);
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const [isRenamingSession, setIsRenamingSession] = useState(false);
	const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
	const [isScrollPinned, setIsScrollPinned] = useState(true);
	const [canvasSnapshot, setCanvasSnapshot] = useState<CanvasSnapshot>(createEmptyCanvasSnapshot);
	const [canvasState, setCanvasState] = useState<LoadState>("loading");
	const [canvasError, setCanvasError] = useState<string | null>(null);
	const [isCanvasOpen, setIsCanvasOpen] = useState(true);
	const loadCounterRef = useRef(0);
	const messageViewportRef = useRef<HTMLDivElement | null>(null);
	const streamAbortControllersRef = useRef(new Map<string, AbortController>());
	const activityTimeoutsRef = useRef(new Map<string, number>());
	const followUpRefreshTimeoutsRef = useRef(new Map<string, number>());
	const browserSessionIdRef = useRef(`browser-${crypto.randomUUID()}`);

	const clearActivityTimeout = (sessionId: string) => {
		const timeoutId = activityTimeoutsRef.current.get(sessionId);
		if (timeoutId === undefined) {
			return;
		}

		window.clearTimeout(timeoutId);
		activityTimeoutsRef.current.delete(sessionId);
	};

	const setSessionActivity = (sessionId: string, activity: SessionActivity | null) => {
		clearActivityTimeout(sessionId);

		setSessionActivityById((current) => {
			if (!activity) {
				if (!(sessionId in current)) {
					return current;
				}

				const next = { ...current };
				delete next[sessionId];
				return next;
			}

			return { ...current, [sessionId]: activity };
		});

		if (activity?.phase === "done") {
			const timeoutId = window.setTimeout(() => {
				activityTimeoutsRef.current.delete(sessionId);
				setSessionActivityById((current) => {
					const currentActivity = current[sessionId];
					if (!currentActivity || currentActivity.phase !== "done") {
						return current;
					}

					const next = { ...current };
					delete next[sessionId];
					return next;
				});
			}, DONE_BADGE_TIMEOUT_MS);

			activityTimeoutsRef.current.set(sessionId, timeoutId);
		}
	};

	const clearFollowUpSessionRefresh = (sessionId: string) => {
		const timeoutId = followUpRefreshTimeoutsRef.current.get(sessionId);
		if (timeoutId === undefined) {
			return;
		}

		window.clearTimeout(timeoutId);
		followUpRefreshTimeoutsRef.current.delete(sessionId);
	};

	const scheduleFollowUpSessionRefresh = (sessionId: string) => {
		clearFollowUpSessionRefresh(sessionId);
		const timeoutId = window.setTimeout(() => {
			followUpRefreshTimeoutsRef.current.delete(sessionId);
			void refreshCurrentSession(sessionId).catch(() => {});
		}, FOLLOW_UP_SESSION_REFRESH_DELAY_MS);
		followUpRefreshTimeoutsRef.current.set(sessionId, timeoutId);
	};

	const upsertSessionDetail = (detail: SessionDetail) => {
		setSessionDetailsById((current) => ({
			...current,
			[detail.id]: detail,
		}));
	};

	const updateSessionDetail = (sessionId: string, updater: (detail: SessionDetail) => SessionDetail) => {
		setSessionDetailsById((current) => {
			const detail = current[sessionId];
			if (!detail) {
				return current;
			}

			return {
				...current,
				[sessionId]: updater(detail),
			};
		});
	};

	useEffect(() => {
		const runtimeTarget = globalThis as typeof globalThis & {
			__PI_CHAT_CANVAS_RUNTIME__?: {
				react: typeof ReactNamespace;
				jsxRuntime: typeof ReactJsxRuntime & { jsxDEV?: typeof ReactJsxDevRuntime.jsxDEV };
			};
		};

		runtimeTarget.__PI_CHAT_CANVAS_RUNTIME__ = {
			react: ReactNamespace,
			jsxRuntime: {
				...ReactJsxRuntime,
				jsxDEV: ReactJsxDevRuntime.jsxDEV,
			},
		};

		void refreshSessions();
		void refreshCanvas();
		return () => {
			delete runtimeTarget.__PI_CHAT_CANVAS_RUNTIME__;
			for (const controller of streamAbortControllersRef.current.values()) {
				controller.abort();
			}

			for (const timeoutId of activityTimeoutsRef.current.values()) {
				window.clearTimeout(timeoutId);
			}

			for (const timeoutId of followUpRefreshTimeoutsRef.current.values()) {
				window.clearTimeout(timeoutId);
			}

			streamAbortControllersRef.current.clear();
			activityTimeoutsRef.current.clear();
			followUpRefreshTimeoutsRef.current.clear();
		};
	}, []);

	const applyCanvasEvent = (event: CanvasEvent) => {
		if (event.type === "canvas.snapshot") {
			setCanvasSnapshot(event.snapshot);
			setCanvasState("ready");
			setCanvasError(null);
			return;
		}

		if (event.type === "canvas.card.published" || event.type === "canvas.card.updated") {
			const updateCards = event.type === "canvas.card.published" ? upsertCanvasCard : replaceCanvasCard;
			setCanvasSnapshot((current) => ({
				...current,
				cards: updateCards(current.cards, event.card),
			}));
			setCanvasState("ready");
			return;
		}

		if (event.type === "canvas.card.removed") {
			setCanvasSnapshot((current) => {
				const nextDiagnostics = { ...current.diagnostics };
				delete nextDiagnostics[event.cardId];
				return {
					...current,
					cards: current.cards.filter((card) => card.id !== event.cardId),
					diagnostics: nextDiagnostics,
				};
			});
			return;
		}

		if (event.type === "canvas.card.error") {
			setCanvasSnapshot((current) => ({
				...current,
				diagnostics: {
					...current.diagnostics,
					[event.cardId]: event.diagnostics,
				},
			}));
			return;
		}

		if (
			event.type === "canvas.visibility.requested" &&
			(!event.request.browserSessionId || event.request.browserSessionId === browserSessionIdRef.current)
		) {
			setIsCanvasOpen(event.request.visibility === "open");
		}
	};

	useEffect(() => {
		const abortController = new AbortController();

		void streamCanvasEvents(browserSessionIdRef.current, {
			signal: abortController.signal,
			onEvent: applyCanvasEvent,
		}).catch((error: unknown) => {
			if (abortController.signal.aborted) {
				return;
			}

			setCanvasState("error");
			setCanvasError(error instanceof Error ? error.message : String(error));
		});

		return () => {
			abortController.abort();
		};
	}, []);

	useEffect(() => {
		if (sessions.length === 0) {
			setSelectedSessionId(null);
			setSelectedSessionState("idle");
			return;
		}

		if (!selectedSessionId || !sessions.some((session) => session.id === selectedSessionId)) {
			startTransition(() => {
				setSelectedSessionId(sessions[0]?.id ?? null);
			});
		}
	}, [selectedSessionId, sessions]);

	useEffect(() => {
		if (!selectedSessionId) {
			setSelectedSessionState(sessions.length === 0 ? "idle" : "ready");
			return;
		}

		const requestId = ++loadCounterRef.current;
		const hasCachedDetail = sessionDetailsById[selectedSessionId] !== undefined;
		setSelectedSessionState(hasCachedDetail ? "ready" : "loading");
		setChatError(null);

		void getSession(selectedSessionId)
			.then((detail) => {
				if (loadCounterRef.current !== requestId) {
					return;
				}
				upsertSessionDetail(detail);
				setSelectedSessionState("ready");
			})
			.catch((error: unknown) => {
				if (loadCounterRef.current !== requestId) {
					return;
				}
				if (!hasCachedDetail) {
					setSelectedSessionState("error");
				}
				setChatError(error instanceof Error ? error.message : String(error));
			});
	}, [selectedSessionId, sessions.length]);

	useEffect(() => {
		const viewport = messageViewportRef.current;
		if (!viewport || !isScrollPinned) {
			return;
		}

		const frame = requestAnimationFrame(() => {
			viewport.scrollTo({ top: viewport.scrollHeight, behavior: hasLiveStream(selectedSessionId ? sessionActivityById[selectedSessionId] : undefined) ? "auto" : "smooth" });
		});

		return () => cancelAnimationFrame(frame);
	}, [isScrollPinned, selectedSessionId, sessionActivityById, sessionDetailsById]);

	async function refreshSessions(): Promise<void> {
		setSessionsState("loading");
		setSidebarError(null);

		try {
			const nextSessions = sortSessions(await listSessions());
			setSessions(nextSessions);
			setSessionsState("ready");
		} catch (error) {
			setSessionsState("error");
			setSidebarError(error instanceof Error ? error.message : String(error));
		}
	}

	async function refreshCurrentSession(sessionId: string): Promise<void> {
		const [detail, nextSessions] = await Promise.all([getSession(sessionId), listSessions()]);
		setSessions(sortSessions(nextSessions));
		upsertSessionDetail(detail);
	}

	async function refreshCanvas(): Promise<void> {
		setCanvasState("loading");
		setCanvasError(null);

		try {
			const snapshot = await getCanvasSnapshot();
			setCanvasSnapshot(snapshot);
			setCanvasState("ready");
		} catch (error) {
			setCanvasState("error");
			setCanvasError(error instanceof Error ? error.message : String(error));
		}
	}

	async function handleCreateSession(): Promise<void> {
		setIsCreatingSession(true);
		setSidebarError(null);

		try {
			const detail = await createSession();
			setSessions((current) => upsertSummary(current, detail));
			upsertSessionDetail(detail);
			setSelectedSessionId(detail.id);
		} catch (error) {
			setSidebarError(error instanceof Error ? error.message : String(error));
		} finally {
			setIsCreatingSession(false);
		}
	}

	async function handleRenameSession(name: string): Promise<void> {
		const selectedSession = selectedSessionId ? sessionDetailsById[selectedSessionId] ?? null : null;
		if (!selectedSession) {
			return;
		}

		setIsRenamingSession(true);
		setSessionActionError(null);

		try {
			const detail = await renameSession(selectedSession.id, name);
			upsertSessionDetail(detail);
			setSessions((current) => upsertSummary(current, detail));
		} catch (error) {
			setSessionActionError(error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			setIsRenamingSession(false);
		}
	}

	async function handleDeleteSession(sessionId: string): Promise<void> {
		if (!sessions.some((session) => session.id === sessionId)) {
			return;
		}

		if (hasLiveStream(sessionActivityById[sessionId])) {
			return;
		}

		const isDeletingSelectedSession = selectedSessionId === sessionId;
		setDeletingSessionId(sessionId);

		if (isDeletingSelectedSession) {
			setSessionActionError(null);
		} else {
			setSidebarError(null);
		}

		try {
			await deleteSession(sessionId);
			const remainingSessions = sessions.filter((session) => session.id !== sessionId);
			setSessions(remainingSessions);
			clearActivityTimeout(sessionId);
			clearFollowUpSessionRefresh(sessionId);
			setSessionActivity(sessionId, null);
			setSessionDetailsById((current) => {
				if (!(sessionId in current)) {
					return current;
				}

				const next = { ...current };
				delete next[sessionId];
				return next;
			});

			if (isDeletingSelectedSession) {
				setChatError(null);

				startTransition(() => {
					setSelectedSessionId(remainingSessions[0]?.id ?? null);
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isDeletingSelectedSession) {
				setSessionActionError(message);
			} else {
				setSidebarError(message);
			}
		} finally {
			setDeletingSessionId((current) => (current === sessionId ? null : current));
		}
	}

	async function handleComposerSubmit(): Promise<void> {
		const selectedSession = selectedSessionId ? sessionDetailsById[selectedSessionId] ?? null : null;
		if (!selectedSession) {
			return;
		}

		if (hasLiveStream(selectedSessionId ? sessionActivityById[selectedSessionId] : undefined)) {
			return;
		}

		const prompt = composerValue.trim();
		if (!prompt) {
			return;
		}

		setComposerValue("");
		setChatError(null);

		const streamingSessionId = selectedSession.id;
		clearFollowUpSessionRefresh(streamingSessionId);

		const optimistic = createOptimisticDetail(selectedSession, prompt);
		upsertSessionDetail(optimistic.detail);
		setSessions((current) => upsertSummary(current, optimistic.detail));
		setSessionActivity(streamingSessionId, { phase: "connecting", label: "Opening stream..." });

		const abortController = new AbortController();
		streamAbortControllersRef.current.set(streamingSessionId, abortController);
		let streamFailed = false;

		const updateStreamingSession = (updater: (detail: SessionDetail) => SessionDetail) => {
			updateSessionDetail(streamingSessionId, updater);
		};

		const markStreamError = (message: string) => {
			streamFailed = true;
			setSessionActivity(streamingSessionId, { phase: "error", label: message });
			updateStreamingSession((current) =>
				updateAssistantMessage(current, optimistic.assistantId, (assistantMessage) => ({
					...assistantMessage,
					content: assistantMessage.content || message,
					status: "error",
				})),
			);
		};

		try {
			await streamSessionMessage(streamingSessionId, prompt, {
				signal: abortController.signal,
				onEvent: (event: StreamEvent) => {
					if (streamFailed && event.type !== "error") {
						return;
					}

					if (event.type === "session.started") {
						setSessionActivity(streamingSessionId, { phase: "connecting", label: "Session accepted. Waiting for response..." });
						return;
					}

					if (event.type === "message.assistant.delta") {
						setSessionActivity(streamingSessionId, { phase: "streaming", label: "Assistant is streaming..." });
						updateStreamingSession((current) =>
							updateAssistantMessage(current, optimistic.assistantId, (message) => ({
								...message,
								content: message.content + event.delta,
								status: "streaming",
							})),
						);
						return;
					}

					if (event.type === "message.assistant.done") {
						setSessionActivity(streamingSessionId, { phase: "streaming", label: "Persisting assistant reply..." });
						updateStreamingSession((current) => updateAssistantMessage(current, optimistic.assistantId, () => event.message));
						return;
					}

					if (event.type === "tool.start") {
						setSessionActivity(streamingSessionId, { phase: "streaming", label: `Running ${event.toolName}...` });
						return;
					}

					if (event.type === "tool.update") {
						setSessionActivity(streamingSessionId, { phase: "streaming", label: `${event.toolName}: ${event.content || "working"}` });
						return;
					}

					if (event.type === "tool.end") {
						setSessionActivity(streamingSessionId, { phase: "streaming", label: `${event.toolName} finished.` });
						return;
					}

					if (event.type === "error") {
						markStreamError(event.message);
						return;
					}

					if (event.type === "session.done") {
						setSessionActivity(streamingSessionId, { phase: "done", label: "Response saved." });
					}
				},
			});

			if (streamFailed) {
				return;
			}

			await refreshCurrentSession(streamingSessionId);
			scheduleFollowUpSessionRefresh(streamingSessionId);
			setSessionActivity(streamingSessionId, { phase: "done", label: "Response saved." });
		} catch (error) {
			if (abortController.signal.aborted) {
				markStreamError("The stream was interrupted.");
			} else {
				const message = error instanceof Error ? error.message : String(error);
				markStreamError(message);
			}
		} finally {
			streamAbortControllersRef.current.delete(streamingSessionId);
		}
	}

	const isDeletingSession = deletingSessionId !== null;
	const selectedSessionDisplay = selectedSessionId ? sessionDetailsById[selectedSessionId] ?? null : null;
	const selectedSessionActivity = selectedSessionId ? sessionActivityById[selectedSessionId] : undefined;
	const selectedStreamStatus = selectedSessionActivity ?? { phase: "idle", label: "Ready." };
	const selectedStreamError = selectedSessionActivity?.phase === "error" ? selectedSessionActivity.label : null;
	const isSelectedSessionStreaming = hasLiveStream(selectedSessionActivity);

	return (
		<div className="flex min-h-dvh overflow-y-auto bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.14),_transparent_28%),linear-gradient(180deg,_#1a1410_0%,_#0b0907_100%)] px-3 py-3 text-stone-100 sm:px-4 sm:py-4 lg:h-dvh lg:overflow-hidden lg:px-5 lg:py-5">
			<div
				className={`mx-auto flex w-full max-w-[96rem] flex-col gap-3 lg:min-h-0 lg:flex-1 lg:grid ${
					isCanvasOpen ? "lg:grid-cols-[19rem_minmax(0,1fr)_24rem]" : "lg:grid-cols-[19rem_minmax(0,1fr)]"
				}`}
			>
				<div className="order-2 lg:order-1 lg:min-h-0">
					<SessionSidebar
						sessions={sessions}
						selectedSessionId={selectedSessionId}
						isLoading={sessionsState === "loading"}
						isCreating={isCreatingSession}
						deletingSessionId={deletingSessionId}
						activityBySessionId={sessionActivityById}
						errorMessage={sidebarError}
						onCreateSession={() => void handleCreateSession()}
						onSelectSession={(sessionId) => startTransition(() => setSelectedSessionId(sessionId))}
						onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
					/>
				</div>

				<main className="order-1 relative flex min-h-[24rem] shrink-0 flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.14),_transparent_38%),linear-gradient(180deg,_rgba(28,23,19,0.98),_rgba(12,10,9,0.98))] shadow-[0_30px_90px_rgba(0,0,0,0.32)] lg:order-2 lg:min-h-0">
					<div className="absolute right-3 top-3 z-10 rounded-full border border-white/10 bg-black/35 px-2.5 py-1 text-[11px] tracking-[0.02em] text-stone-300 backdrop-blur-sm sm:right-4 sm:top-4">
						<span className={`font-medium uppercase tracking-[0.18em] ${statusTone(selectedStreamStatus.phase)}`}>{selectedStreamStatus.phase}</span>
						<span className="mx-1.5 text-stone-500">/</span>
						<span>{selectedStreamStatus.label}</span>
					</div>
					<div className="border-b border-white/10 px-4 py-3 sm:px-5 sm:py-3">
						<div className="flex items-start justify-between gap-4 pr-24">
							<div>
								<p className="text-xs uppercase tracking-[0.35em] text-stone-400">Conversation</p>
								{selectedSessionDisplay ? (
									<div className="mt-2.5">
										<EditableSessionTitle
											value={selectedSessionDisplay.name ?? ""}
											displayName={selectedSessionDisplay.displayName}
											disabled={isSelectedSessionStreaming}
											pending={isRenamingSession}
											isDeleting={deletingSessionId === selectedSessionDisplay.id}
											errorMessage={sessionActionError}
											onRename={handleRenameSession}
											onDelete={() => handleDeleteSession(selectedSessionDisplay.id)}
										/>
									</div>
								) : (
									<div className="mt-2.5 max-w-2xl">
										<h2 className="text-2xl font-semibold tracking-tight text-stone-50 sm:text-3xl">Build from the plan, not from stubs.</h2>
										<p className="mt-2 text-sm leading-6 text-stone-300">
											Create a session to start chatting with the request-scoped Pi runtime.
										</p>
									</div>
								)}
							</div>
							<button
								type="button"
								onClick={() => setIsCanvasOpen((current) => !current)}
								className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.2em] text-cyan-100 transition hover:border-cyan-200/45 hover:bg-cyan-300/20"
							>
								{isCanvasOpen ? "Hide canvas" : "Open canvas"}
							</button>
						</div>
					</div>

					<div className="flex min-h-0 flex-1 flex-col px-2.5 pb-2.5 pt-2.5 sm:px-3.5 sm:pb-3.5 sm:pt-3">

						{chatError || selectedStreamError ? (
							<p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{chatError ?? selectedStreamError}</p>
						) : null}

						<div
							ref={messageViewportRef}
							onScroll={(event) => {
								const element = event.currentTarget;
								const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
								setIsScrollPinned(remaining < 40);
							}}
							className={`${chatError || selectedStreamError ? "mt-3" : "mt-0"} flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[1.5rem] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))] px-2.5 py-3 sm:px-4`}
						>
							{selectedSessionState === "loading" ? (
								<div className="space-y-4">
									{Array.from({ length: 4 }, (_, index) => (
										<div key={index} className="h-24 animate-pulse rounded-[1.6rem] border border-white/8 bg-white/5" />
									))}
								</div>
							) : !selectedSessionDisplay ? (
								<div className="m-auto max-w-xl px-6 text-center">
									<p className="text-xs uppercase tracking-[0.28em] text-amber-300/70">Workspace chat</p>
									<h3 className="mt-4 text-3xl font-semibold tracking-tight text-stone-50">Session list on the left, live transcript on the right.</h3>
									<p className="mt-4 text-base leading-7 text-stone-400">
										The UI now speaks the same DTOs as the backend and is ready for real session traffic.
									</p>
								</div>
							) : selectedSessionDisplay.messages.length === 0 ? (
								<div className="m-auto max-w-lg px-6 text-center">
									<p className="text-xs uppercase tracking-[0.28em] text-stone-500">Empty transcript</p>
									<h3 className="mt-4 text-2xl font-semibold text-stone-50">Start with a prompt about the workspace.</h3>
									<p className="mt-4 text-base leading-7 text-stone-400">
										Your first message becomes the fallback session title until you rename it.
									</p>
								</div>
							) : (
								<div className="space-y-3 pb-1">
									{selectedSessionDisplay.messages.map((message) => (
										<MessageBubble key={message.id} message={message} />
									))}
								</div>
							)}
						</div>

						<div className="mt-3">
							<Composer
								value={composerValue}
								onChange={setComposerValue}
								onSubmit={() => void handleComposerSubmit()}
								disabled={!selectedSessionDisplay || isSelectedSessionStreaming}
							/>
						</div>
					</div>
				</main>

				{isCanvasOpen ? (
					<>
						<button
							type="button"
							aria-label="Close canvas overlay"
							onClick={() => setIsCanvasOpen(false)}
							className="fixed inset-0 z-10 bg-black/45 backdrop-blur-[1px] lg:hidden"
						/>
						<div className="fixed inset-y-3 right-3 z-20 w-[min(24rem,calc(100vw-1.5rem))] lg:static lg:z-auto lg:min-h-0 lg:w-auto">
							<CanvasPanel
								browserSessionId={browserSessionIdRef.current}
								cards={canvasSnapshot.cards}
								diagnostics={canvasSnapshot.diagnostics}
								loadState={canvasState}
								errorMessage={canvasError}
								onClose={() => setIsCanvasOpen(false)}
							/>
						</div>
					</>
				) : null}
			</div>
		</div>
	);
}
