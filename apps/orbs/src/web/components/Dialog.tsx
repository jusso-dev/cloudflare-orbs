import { useEffect, useRef, type ReactNode } from "react";

/** A modal built on the native <dialog>: focus trapping, Escape to close, and inert background for free. */
export function Dialog({
	open,
	onClose,
	title,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	}, [open]);

	return (
		<dialog
			ref={ref}
			className="dialog"
			aria-labelledby="dialog-title"
			onClose={onClose}
			onClick={(event) => {
				if (event.target === ref.current) onClose();
			}}
		>
			{open && (
				<div className="dialog-body">
					<h2 id="dialog-title">{title}</h2>
					{children}
				</div>
			)}
		</dialog>
	);
}
