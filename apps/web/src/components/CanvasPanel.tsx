import {
	Component,
	type ComponentType,
	type ErrorInfo,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { CanvasCard, CanvasDiagnostics } from "@pi-chat/shared";
import { postCanvasRuntimeEvent } from "../api";

type LoadState = "idle" | "loading" | "ready" | "error";

interface CanvasCardHost {
	ready: () => void;
	setTitle: (title: string) => void;
}

interface CanvasCardComponentProps {
	cardId: string;
	data: unknown;
	host: CanvasCardHost;
}

class CanvasCardErrorBoundary extends Component<
	{
		children: ReactNode;
		onError: (error: Error) => void;
	},
	{ errorMessage: string | null }
> {
	override state = {
		errorMessage: null,
	};

	static getDerivedStateFromError(error: Error) {
		return {
			errorMessage: error.message,
		};
	}

	override componentDidCatch(error: Error, _info: ErrorInfo): void {
		this.props.onError(error);
	}

	override componentDidUpdate(prevProps: Readonly<{ children: ReactNode; onError: (error: Error) => void }>) {
		if (prevProps.children !== this.props.children && this.state.errorMessage) {
			this.setState({ errorMessage: null });
		}
	}

	override render() {
		if (this.state.errorMessage) {
			return (
				<div className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
					<p className="font-medium">{this.state.errorMessage}</p>
					<p className="mt-1 text-xs uppercase tracking-[0.18em] text-rose-200/80">runtime error</p>
				</div>
			);
		}

		return this.props.children;
	}
}

function statusClasses(status: CanvasCard["status"]): string {
	switch (status) {
		case "ready":
			return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
		case "build_error":
		case "runtime_error":
			return "border-rose-400/30 bg-rose-500/10 text-rose-200";
		default:
			return "border-amber-300/30 bg-amber-300/10 text-amber-100";
	}
}

function CanvasCardFrame(props: {
	browserSessionId: string;
	card: CanvasCard;
	diagnostics: CanvasDiagnostics[string];
}) {
	const [displayTitle, setDisplayTitle] = useState(props.card.title);
	const [LoadedComponent, setLoadedComponent] = useState<ComponentType<CanvasCardComponentProps> | null>(null);
	const [runtimeError, setRuntimeError] = useState<string | null>(null);
	const [moduleState, setModuleState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [isRenderedReady, setIsRenderedReady] = useState(false);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const hasReportedReadyRef = useRef(false);
	const lastReportedHeightRef = useRef<number | null>(props.card.lastMeasuredHeight ?? null);

	useEffect(() => {
		setDisplayTitle(props.card.title);
	}, [props.card.title]);

	useEffect(() => {
		lastReportedHeightRef.current = props.card.lastMeasuredHeight ?? null;
	}, [props.card.id, props.card.lastMeasuredHeight]);

	useEffect(() => {
		if (!props.card.bundleUrl || props.card.status === "build_error") {
			setLoadedComponent(null);
			setRuntimeError(null);
			setIsRenderedReady(false);
			hasReportedReadyRef.current = false;
			lastReportedHeightRef.current = props.card.lastMeasuredHeight ?? null;
			setModuleState("idle");
			return;
		}

		let isActive = true;
		setLoadedComponent(null);
		setRuntimeError(null);
		setIsRenderedReady(false);
		hasReportedReadyRef.current = false;
		lastReportedHeightRef.current = props.card.lastMeasuredHeight ?? null;
		setModuleState("loading");

		void import(/* @vite-ignore */ props.card.bundleUrl)
			.then((module) => {
				if (!isActive) {
					return;
				}

				if (typeof module.default !== "function") {
					throw new Error("Canvas bundle is missing a default React component export.");
				}

				setLoadedComponent(() => module.default as ComponentType<CanvasCardComponentProps>);
				setModuleState("ready");
			})
			.catch((error: unknown) => {
				if (!isActive) {
					return;
				}

				const message = error instanceof Error ? error.message : String(error);
				setLoadedComponent(null);
				setRuntimeError(message);
				setModuleState("error");
				void postCanvasRuntimeEvent(props.card.id, {
					type: "runtime_error",
					message,
					browserSessionId: props.browserSessionId,
				});
			});

		return () => {
			isActive = false;
		};
	}, [props.card.bundleUrl, props.card.status]);

	const host = useMemo<CanvasCardHost>(
		() => ({
			ready: () => {
				setIsRenderedReady(true);
				if (hasReportedReadyRef.current) {
					return;
				}

				hasReportedReadyRef.current = true;
				void postCanvasRuntimeEvent(props.card.id, {
					type: "ready",
					browserSessionId: props.browserSessionId,
				});
			},
			setTitle: (title: string) => setDisplayTitle(title),
		}),
		[props.browserSessionId, props.card.id],
	);

	useEffect(() => {
		const element = contentRef.current;
		if (!element || !LoadedComponent || typeof ResizeObserver === "undefined") {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			const height = Math.round(entries[0]?.contentRect.height ?? element.getBoundingClientRect().height);
			if (lastReportedHeightRef.current === height) {
				return;
			}

			lastReportedHeightRef.current = height;
			void postCanvasRuntimeEvent(props.card.id, {
				type: "resize",
				height,
				browserSessionId: props.browserSessionId,
			});
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [LoadedComponent, props.browserSessionId, props.card.id]);

	return (
		<section className="rounded-[1.5rem] border border-white/8 bg-white/4 p-4 shadow-[0_18px_45px_rgba(0,0,0,0.2)]">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="truncate text-base font-semibold text-stone-50">{displayTitle}</h3>
					<p className="mt-2 text-xs uppercase tracking-[0.18em] text-stone-500">{props.card.componentPath}</p>
					{props.card.lastMeasuredHeight !== undefined ? (
						<p className="mt-2 text-xs uppercase tracking-[0.18em] text-stone-500">
							{props.card.lastMeasuredHeight}px tall
						</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{isRenderedReady ? (
						<span className="rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-100">
							live
						</span>
					) : null}
					<span
						className={`rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] ${statusClasses(props.card.status)}`}
					>
						{props.card.status.replace("_", " ")}
					</span>
				</div>
			</div>

			<div ref={contentRef} className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-4 text-sm text-stone-200">
				{LoadedComponent ? (
					<CanvasCardErrorBoundary
						onError={(error) => {
							setRuntimeError(error.message);
							setModuleState("error");
							void postCanvasRuntimeEvent(props.card.id, {
								type: "runtime_error",
								message: error.message,
								browserSessionId: props.browserSessionId,
								...(error.stack ? { stack: error.stack } : {}),
							});
						}}
					>
						<LoadedComponent cardId={props.card.id} data={props.card.props} host={host} />
					</CanvasCardErrorBoundary>
				) : runtimeError ? (
					<div className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-rose-100">
						<p className="font-medium">{runtimeError}</p>
						<p className="mt-1 text-xs uppercase tracking-[0.18em] text-rose-200/80">runtime bootstrap</p>
					</div>
				) : moduleState === "loading" ? (
					<p className="text-stone-400">Loading published card...</p>
				) : props.card.status === "ready" ? (
					<p className="text-stone-400">Published bundle ready to mount.</p>
				) : props.card.status === "draft" ? (
					<p className="text-stone-400">Waiting for the browser to confirm that the card mounted successfully.</p>
				) : (
					<p className="text-stone-400">This card is waiting on a successful publish.</p>
				)}
			</div>

			{props.diagnostics.length > 0 ? (
				<div className="mt-4 space-y-2">
					{props.diagnostics.map((diagnostic) => (
						<div
							key={diagnostic.id}
							className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100"
						>
							<p className="font-medium">{diagnostic.message}</p>
							<p className="mt-1 text-xs uppercase tracking-[0.18em] text-rose-200/80">
								{diagnostic.stage}
								{diagnostic.filePath ? ` / ${diagnostic.filePath}` : ""}
							</p>
						</div>
					))}
				</div>
			) : null}
		</section>
	);
}

export function CanvasPanel(props: {
	browserSessionId: string;
	cards: CanvasCard[];
	diagnostics: CanvasDiagnostics;
	loadState: LoadState;
	errorMessage: string | null;
	onClose: () => void;
}) {
	return (
		<aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-[linear-gradient(180deg,rgba(20,18,16,0.98),rgba(10,8,7,0.98))] shadow-[0_30px_90px_rgba(0,0,0,0.32)]">
			<div className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
				<div>
					<p className="text-xs uppercase tracking-[0.35em] text-cyan-300/75">Workspace</p>
					<h2 className="mt-2 text-2xl font-semibold tracking-tight text-stone-50">Canvas</h2>
					<p className="mt-2 text-sm leading-6 text-stone-400">
						Published cards live here across every chat session in the workspace.
					</p>
				</div>
				<button
					type="button"
					onClick={props.onClose}
					className="rounded-full border border-white/12 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-stone-300 transition hover:border-white/28 hover:text-stone-100"
				>
					Close
				</button>
			</div>

			<div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3 text-[11px] uppercase tracking-[0.2em] text-stone-500 sm:px-5">
				<span>{props.cards.length} cards</span>
				<span>{props.loadState === "loading" ? "Syncing..." : "Workspace-scoped"}</span>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
				{props.errorMessage ? (
					<p className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
						{props.errorMessage}
					</p>
				) : null}

				{props.loadState === "loading" ? (
					<div className={`${props.errorMessage ? "mt-3" : "mt-0"} space-y-3`}>
						{Array.from({ length: 3 }, (_, index) => (
							<div key={index} className="h-28 animate-pulse rounded-[1.5rem] border border-white/8 bg-white/5" />
						))}
					</div>
				) : props.cards.length === 0 ? (
					<div className={`${props.errorMessage ? "mt-3" : "mt-0"} rounded-[1.6rem] border border-dashed border-white/12 bg-white/4 px-5 py-8 text-center`}>
						<p className="text-xs uppercase tracking-[0.28em] text-stone-500">No cards yet</p>
						<h3 className="mt-4 text-xl font-semibold tracking-tight text-stone-50">The canvas shell is ready.</h3>
						<p className="mt-3 text-sm leading-6 text-stone-400">
							Publish a React component from <code className="rounded bg-black/20 px-1.5 py-0.5 text-[0.92em] text-stone-200">workspace/canvas/cards</code> to render it here.
						</p>
					</div>
				) : (
					<div className={`${props.errorMessage ? "mt-3" : "mt-0"} space-y-3`}>
						{props.cards.map((card) => (
							<CanvasCardFrame
								key={card.id}
								browserSessionId={props.browserSessionId}
								card={card}
								diagnostics={props.diagnostics[card.id] ?? []}
							/>
						))}
					</div>
				)}
			</div>
		</aside>
	);
}
