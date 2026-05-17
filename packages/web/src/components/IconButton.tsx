import type { ReactNode, SVGProps } from "react";

const ICON_BUTTON_CLASS =
	"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-black/20 transition focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40";

export function ActionIconButton(props: {
	label: string;
	title?: string;
	onClick: () => void;
	disabled?: boolean;
	variant?: "default" | "danger" | "accent";
	children: ReactNode;
}) {
	const toneClassName =
		props.variant === "danger"
			? "border-rose-400/25 text-rose-200 hover:border-rose-300/45 hover:text-rose-100 focus-visible:ring-rose-300/40"
			: props.variant === "accent"
				? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100 hover:border-cyan-200/45 hover:bg-cyan-300/18 focus-visible:ring-cyan-200/50"
				: "border-white/12 text-stone-300 hover:border-white/28 hover:text-stone-100 focus-visible:ring-amber-300/60";

	return (
		<button
			type="button"
			onClick={props.onClick}
			disabled={props.disabled}
			aria-label={props.label}
			title={props.title ?? props.label}
			className={`${ICON_BUTTON_CLASS} ${toneClassName}`}
		>
			{props.children}
			<span className="sr-only">{props.label}</span>
		</button>
	);
}

export function PencilIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
			<path d="M10.7 2.2a1.6 1.6 0 0 1 2.3 0l.8.8a1.6 1.6 0 0 1 0 2.3L6 13H3v-3l7.7-7.8Z" />
			<path d="m9.8 3.1 3 3" />
		</svg>
	);
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
			<path d="M2.8 4.2h10.4" />
			<path d="M6.1 2.8h3.8" />
			<path d="M4.1 4.2 4.8 13h6.4l.7-8.8" />
			<path d="M6.4 6.6v4.2" />
			<path d="M9.6 6.6v4.2" />
		</svg>
	);
}

export function PanelIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
			<rect x="2.5" y="2.5" width="11" height="11" rx="1.8" />
			<path d="M9.2 2.5v11" />
		</svg>
	);
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
			<path d="M8 3v10" />
			<path d="M3 8h10" />
		</svg>
	);
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
			<path d="m4 4 8 8" />
			<path d="m12 4-8 8" />
		</svg>
	);
}
