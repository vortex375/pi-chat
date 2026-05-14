import { startTransition, useEffect, useRef, useState } from "react";
import type { ChatMessage, SessionDetail, SessionSummary, StreamEvent } from "@pi-chat/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createSession, getSession, listSessions, renameSession, streamSessionMessage } from "./api";

type LoadState = "idle" | "loading" | "ready" | "error";
type StreamPhase = "idle" | "connecting" | "streaming" | "done" | "error";

type StreamStatus = {
	phase: StreamPhase;
	label: string;
};

const EMPTY_SESSION_LABEL = "(no messages)";

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

function updateAssistantMessage(detail: SessionDetail, assistantId: string, updater: (message: ChatMessage) => ChatMessage): SessionDetail {
	return {
		...detail,
		messages: detail.messages.map((message) => (message.id === assistantId ? updater(message) : message)),
	};
}

function createOptimisticDetail(detail: SessionDetail, prompt: string): { assistantId: string; detail: SessionDetail } {
	const optimisticUser = buildLocalMessage("user", prompt, "complete");
	const optimisticAssistant = buildLocalMessage("assistant", "", "streaming");
	const displayName = detail.hasCustomName || detail.firstMessage !== EMPTY_SESSION_LABEL ? detail.displayName : prompt;

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

function SessionSidebar(props: {
	sessions: SessionSummary[];
	selectedSessionId: string | null;
	isLoading: boolean;
	isCreating: boolean;
	isBusy: boolean;
	errorMessage: string | null;
	onCreateSession: () => void;
	onSelectSession: (sessionId: string) => void;
}) {
	return (
		<aside className="flex w-full flex-col rounded-[1.75rem] border border-white/10 bg-[linear-gradient(180deg,rgba(31,24,20,0.96),rgba(17,14,12,0.98))] p-4 shadow-[0_30px_90px_rgba(0,0,0,0.35)] lg:max-w-[19rem]">
			<div className="flex items-start justify-between gap-3 border-b border-white/10 pb-4">
				<div>
					<p className="text-xs uppercase tracking-[0.35em] text-amber-300/80">Pi Chat</p>
					<h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-50">Sessions</h1>
				</div>
				<button
					type="button"
					onClick={props.onCreateSession}
					disabled={props.isCreating || props.isBusy}
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
						return (
							<button
								key={session.id}
								type="button"
								onClick={() => props.onSelectSession(session.id)}
								disabled={props.isBusy}
								className={`rounded-[1.4rem] border px-3.5 py-3 text-left transition ${
									isSelected
										? "border-amber-300/40 bg-amber-300/12 text-stone-50 shadow-[0_12px_40px_rgba(245,158,11,0.12)]"
										: "border-white/8 bg-white/4 text-stone-200 hover:border-white/14 hover:bg-white/7"
								} disabled:cursor-not-allowed disabled:opacity-40`}
							>
								<div className="flex items-start justify-between gap-3">
									<div>
										<p className="line-clamp-2 text-sm font-medium leading-6">{session.displayName}</p>
										<p className="mt-1 line-clamp-2 text-xs leading-5 text-stone-400">{session.firstMessage}</p>
									</div>
									<p className="shrink-0 text-[11px] uppercase tracking-[0.2em] text-stone-500">
										{formatTime(session.modifiedAt)}
									</p>
								</div>
							</button>
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
	errorMessage: string | null;
	onRename: (name: string) => Promise<void>;
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
	const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
	const [selectedSessionState, setSelectedSessionState] = useState<LoadState>("idle");
	const [composerValue, setComposerValue] = useState("");
	const [sidebarError, setSidebarError] = useState<string | null>(null);
	const [chatError, setChatError] = useState<string | null>(null);
	const [renameError, setRenameError] = useState<string | null>(null);
	const [streamStatus, setStreamStatus] = useState<StreamStatus>({ phase: "idle", label: "Ready." });
	const [isCreatingSession, setIsCreatingSession] = useState(false);
	const [isRenamingSession, setIsRenamingSession] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [isScrollPinned, setIsScrollPinned] = useState(true);
	const loadCounterRef = useRef(0);
	const messageViewportRef = useRef<HTMLDivElement | null>(null);
	const streamAbortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		void refreshSessions();
		return () => {
			streamAbortRef.current?.abort();
		};
	}, []);

	useEffect(() => {
		if (sessions.length === 0) {
			setSelectedSessionId(null);
			setSelectedSession(null);
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
			setSelectedSession(null);
			setSelectedSessionState(sessions.length === 0 ? "idle" : "ready");
			return;
		}

		const requestId = ++loadCounterRef.current;
		setSelectedSessionState("loading");
		setChatError(null);

		void getSession(selectedSessionId)
			.then((detail) => {
				if (loadCounterRef.current !== requestId) {
					return;
				}
				setSelectedSession(detail);
				setSelectedSessionState("ready");
			})
			.catch((error: unknown) => {
				if (loadCounterRef.current !== requestId) {
					return;
				}
				setSelectedSessionState("error");
				setChatError(error instanceof Error ? error.message : String(error));
			});
	}, [selectedSessionId, sessions.length]);

	useEffect(() => {
		const viewport = messageViewportRef.current;
		if (!viewport || !isScrollPinned) {
			return;
		}

		const frame = requestAnimationFrame(() => {
			viewport.scrollTo({ top: viewport.scrollHeight, behavior: isStreaming ? "auto" : "smooth" });
		});

		return () => cancelAnimationFrame(frame);
	}, [isScrollPinned, isStreaming, selectedSession]);

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
		setSelectedSession((current) => (current?.id === sessionId ? detail : current));
	}

	async function handleCreateSession(): Promise<void> {
		setIsCreatingSession(true);
		setSidebarError(null);

		try {
			const detail = await createSession();
			setSessions((current) => upsertSummary(current, detail));
			setSelectedSession(detail);
			startTransition(() => {
				setSelectedSessionId(detail.id);
			});
		} catch (error) {
			setSidebarError(error instanceof Error ? error.message : String(error));
		} finally {
			setIsCreatingSession(false);
		}
	}

	async function handleRenameSession(name: string): Promise<void> {
		if (!selectedSession) {
			return;
		}

		setIsRenamingSession(true);
		setRenameError(null);

		try {
			const detail = await renameSession(selectedSession.id, name);
			setSelectedSession(detail);
			setSessions((current) => upsertSummary(current, detail));
		} catch (error) {
			setRenameError(error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			setIsRenamingSession(false);
		}
	}

	async function handleComposerSubmit(): Promise<void> {
		if (!selectedSession || isStreaming) {
			return;
		}

		const prompt = composerValue.trim();
		if (!prompt) {
			return;
		}

		setComposerValue("");
		setChatError(null);
		setStreamStatus({ phase: "connecting", label: "Opening stream..." });
		setIsStreaming(true);

		const streamingSessionId = selectedSession.id;

		const optimistic = createOptimisticDetail(selectedSession, prompt);
		setSelectedSession(optimistic.detail);
		setSessions((current) => upsertSummary(current, optimistic.detail));

		const abortController = new AbortController();
		streamAbortRef.current = abortController;
		let streamFailed = false;

		const updateStreamingSession = (updater: (detail: SessionDetail) => SessionDetail) => {
			setSelectedSession((current) => {
				if (!current || current.id !== streamingSessionId) {
					return current;
				}

				return updater(current);
			});
		};

		const markStreamError = (message: string) => {
			streamFailed = true;
			setChatError(message);
			setStreamStatus({ phase: "error", label: message });
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
						setStreamStatus({ phase: "connecting", label: "Session accepted. Waiting for response..." });
						return;
					}

					if (event.type === "message.assistant.delta") {
						setStreamStatus({ phase: "streaming", label: "Assistant is streaming..." });
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
						setStreamStatus({ phase: "streaming", label: "Persisting assistant reply..." });
						updateStreamingSession((current) => updateAssistantMessage(current, optimistic.assistantId, () => event.message));
						return;
					}

					if (event.type === "tool.start") {
						setStreamStatus({ phase: "streaming", label: `Running ${event.toolName}...` });
						return;
					}

					if (event.type === "tool.update") {
						setStreamStatus({ phase: "streaming", label: `${event.toolName}: ${event.content || "working"}` });
						return;
					}

					if (event.type === "tool.end") {
						setStreamStatus({ phase: "streaming", label: `${event.toolName} finished.` });
						return;
					}

					if (event.type === "error") {
						markStreamError(event.message);
						return;
					}

					if (event.type === "session.done") {
						setStreamStatus({ phase: "done", label: "Response saved." });
					}
				},
			});

			if (streamFailed) {
				return;
			}

			await refreshCurrentSession(streamingSessionId);
			setStreamStatus({ phase: "done", label: "Response saved." });
		} catch (error) {
			if (abortController.signal.aborted) {
				markStreamError("The stream was interrupted.");
			} else {
				const message = error instanceof Error ? error.message : String(error);
				markStreamError(message);
			}
		} finally {
			streamAbortRef.current = null;
			setIsStreaming(false);
		}
	}

	const isBusy = isStreaming || isCreatingSession || isRenamingSession;
	const selectedSessionDisplay = selectedSession ?? null;

	return (
		<div className="flex h-dvh overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(251,191,36,0.14),_transparent_28%),linear-gradient(180deg,_#1a1410_0%,_#0b0907_100%)] px-3 py-3 text-stone-100 sm:px-4 sm:py-4 lg:px-5 lg:py-5">
			<div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-3 lg:grid lg:grid-cols-[19rem_minmax(0,1fr)]">
				<SessionSidebar
					sessions={sessions}
					selectedSessionId={selectedSessionId}
					isLoading={sessionsState === "loading"}
					isCreating={isCreatingSession}
					isBusy={isBusy}
					errorMessage={sidebarError}
					onCreateSession={() => void handleCreateSession()}
					onSelectSession={(sessionId) => startTransition(() => setSelectedSessionId(sessionId))}
				/>

				<main className="relative flex min-h-0 flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-[radial-gradient(circle_at_top,_rgba(245,158,11,0.14),_transparent_38%),linear-gradient(180deg,_rgba(28,23,19,0.98),_rgba(12,10,9,0.98))] shadow-[0_30px_90px_rgba(0,0,0,0.32)]">
					<div className="absolute right-3 top-3 z-10 rounded-full border border-white/10 bg-black/35 px-2.5 py-1 text-[11px] tracking-[0.02em] text-stone-300 backdrop-blur-sm sm:right-4 sm:top-4">
						<span className={`font-medium uppercase tracking-[0.18em] ${statusTone(streamStatus.phase)}`}>{streamStatus.phase}</span>
						<span className="mx-1.5 text-stone-500">/</span>
						<span>{streamStatus.label}</span>
					</div>
					<div className="border-b border-white/10 px-4 py-3 sm:px-5 sm:py-3">
						<p className="text-xs uppercase tracking-[0.35em] text-stone-400">Conversation</p>
						{selectedSessionDisplay ? (
							<div className="mt-2.5">
								<EditableSessionTitle
									value={selectedSessionDisplay.name ?? ""}
									displayName={selectedSessionDisplay.displayName}
									disabled={isStreaming}
									pending={isRenamingSession}
									errorMessage={renameError}
									onRename={handleRenameSession}
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

					<div className="flex min-h-0 flex-1 flex-col px-2.5 pb-2.5 pt-2.5 sm:px-3.5 sm:pb-3.5 sm:pt-3">

						{chatError ? (
							<p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{chatError}</p>
						) : null}

						<div
							ref={messageViewportRef}
							onScroll={(event) => {
								const element = event.currentTarget;
								const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
								setIsScrollPinned(remaining < 40);
							}}
							className={`${chatError ? "mt-3" : "mt-0"} flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[1.5rem] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01))] px-2.5 py-3 sm:px-4`}
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
								disabled={!selectedSessionDisplay || isStreaming}
							/>
						</div>
					</div>
				</main>
			</div>
		</div>
	);
}
