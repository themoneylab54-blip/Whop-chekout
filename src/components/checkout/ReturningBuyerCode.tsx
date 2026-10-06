"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, KeyRound } from "lucide-react";
import type { Labels } from "./i18n";

export type CodeBuyer = {
  email: string;
  address: { firstName: string; lastName: string; address1: string; address2?: string | null; city: string; province?: string | null; zip: string; countryCode: string; phone?: string | null };
  acceptsMarketing: boolean;
};

/**
 * "Déjà client ? Recevez un code par e-mail": sends a one-time code to the e-mail typed above,
 * then checks it; the right code returns the buyer's details from their last paid order, which
 * the checkout fills in. The server never says whether the e-mail is a customer.
 */
export function ReturningBuyerCode({
  sessionId,
  email,
  L,
  inputCls,
  onFilled,
}: {
  sessionId: string;
  email: string;
  L: Labels;
  inputCls: string;
  onFilled: (buyer: CodeBuyer) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<"idle" | "sending" | "sent" | "checking" | "done">("idle");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [sentTo, setSentTo] = useState("");
  // Focus follows each step (WCAG 2.4.3); set by the handlers, applied once React has rendered.
  const focusNext = useRef<"send" | "code" | "done" | null>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "send") sendRef.current?.focus();
    else if (target === "code") codeRef.current?.focus();
    else if (target === "done") doneRef.current?.focus();
  }, [open, stage]);

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function send() {
    if (stage === "sending") return;
    if (!validEmail) {
      focusNext.current = "send";
      return setMessage({ text: L.otpEmailFirst, error: true });
    }
    // The panel swaps to the busy "send" button: focus goes with it, then to the code field.
    focusNext.current = "send";
    setStage("sending");
    setMessage(null);
    try {
      const res = await fetch(`/api/public/sessions/${sessionId}/login-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.status === 429) {
        focusNext.current = sentTo ? "code" : "send";
        setStage(sentTo ? "sent" : "idle");
        return setMessage({ text: L.otpTooMany, error: true });
      }
      if (!res.ok) {
        focusNext.current = "send";
        setStage("idle");
        return setMessage({ text: L.otpError, error: true });
      }
      setSentTo(email.trim());
      setCode("");
      // The code field is described by the "code sent" status: focus lands where the buyer types next.
      focusNext.current = "code";
      setStage("sent");
      setMessage({ text: L.otpSent });
    } catch {
      focusNext.current = "send";
      setStage("idle");
      setMessage({ text: L.otpError, error: true });
    }
  }

  async function verify(value = code) {
    if (stage === "checking") return;
    if (!/^\d{6}$/.test(value.trim())) {
      focusNext.current = "code";
      return setMessage({ text: L.otpInvalid, error: true });
    }
    setStage("checking");
    try {
      const res = await fetch(`/api/public/sessions/${sessionId}/login-code/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: sentTo, code: value.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { buyer?: CodeBuyer };
      if (!res.ok || !body.buyer) {
        focusNext.current = "code";
        setStage("sent");
        return setMessage({ text: res.status === 429 ? L.otpTooMany : L.otpInvalid, error: true });
      }
      onFilled(body.buyer);
      focusNext.current = "done";
      setStage("done");
      setCode("");
      setMessage(null);
    } catch {
      focusNext.current = "code";
      setStage("sent");
      setMessage({ text: L.otpError, error: true });
    }
  }

  if (stage === "done") {
    // The checkout announces the fill (live region): this line only keeps focus in place.
    return (
      <p ref={doneRef} tabIndex={-1} className="mt-1 flex min-h-11 items-center gap-1.5 rounded-sm text-sm text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
        <Check className="h-4 w-4 shrink-0 text-emerald-700" aria-hidden />
        {L.otpFilled}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // E-mail already typed: one click sends the code; otherwise the "send" button takes focus.
          if (validEmail) void send();
          else focusNext.current = "send";
        }}
        className="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-sm text-left text-sm text-neutral-700 underline underline-offset-2 hover:no-underline"
      >
        <KeyRound className="h-4 w-4 shrink-0" aria-hidden />
        {L.otpPrompt}
      </button>
    );
  }

  const describedBy = message ? `${uid}-${message.error ? "err" : "msg"}` : undefined;
  return (
    <div role="group" aria-labelledby={`${uid}-title`} className="mt-2 rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">
      <p id={`${uid}-title`} className="flex items-center gap-1.5 font-medium">
        <KeyRound className="h-4 w-4 shrink-0" aria-hidden />
        {L.otpPrompt}
      </p>
      {stage === "idle" || stage === "sending" ? (
        <button
          ref={sendRef}
          type="button"
          onClick={send}
          // aria-disabled (not disabled) while sending: focus stays on the button.
          aria-disabled={stage === "sending" || undefined}
          aria-busy={stage === "sending"}
          aria-describedby={describedBy}
          className="mt-2 inline-flex min-h-11 items-center rounded-[var(--btn-radius)] bg-[image:var(--btn-bg,var(--accent-bg))] px-3.5 text-sm font-semibold text-[var(--btn-fg,var(--accent-fg))] shadow-[var(--btn-shadow)] aria-disabled:opacity-60"
        >
          {L.otpSend}
        </button>
      ) : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`${uid}-code`} className="mb-1 block text-xs text-neutral-700">
              {L.otpCodeLabel}
            </label>
            <input
              ref={codeRef}
              id={`${uid}-code`}
              value={code}
              onChange={(e) => {
                const next = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(next);
                if (message?.error) setMessage(null);
                // Six digits typed or pasted: checked at once, no extra click.
                if (next.length === 6 && next !== code) void verify(next);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void verify();
                }
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              aria-invalid={!!message?.error || undefined}
              aria-describedby={describedBy}
              className={`${inputCls} !w-32 tracking-[0.3em] tabular-nums`}
            />
          </div>
          <button
            type="button"
            onClick={() => void verify()}
            aria-disabled={stage === "checking" || undefined}
            aria-busy={stage === "checking"}
            className="inline-flex min-h-11 items-center rounded-[var(--btn-radius)] bg-[image:var(--btn-bg,var(--accent-bg))] px-3.5 text-sm font-semibold text-[var(--btn-fg,var(--accent-fg))] shadow-[var(--btn-shadow)] aria-disabled:opacity-60"
          >
            {L.otpVerify}
          </button>
          <button type="button" onClick={send} className="inline-flex min-h-11 items-center rounded-sm px-1 text-sm text-neutral-700 underline underline-offset-2 hover:no-underline">
            {L.otpResend}
          </button>
        </div>
      )}
      {/* The status region stays in the DOM, so screen readers announce each new message. */}
      <p id={`${uid}-msg`} role="status" className={message && !message.error ? "mt-2 text-sm text-neutral-700" : "sr-only"}>
        {message && !message.error ? message.text : ""}
      </p>
      {message?.error && (
        <p id={`${uid}-err`} role="alert" className="mt-2 text-sm text-red-700">
          {message.text}
        </p>
      )}
    </div>
  );
}
