"use client";

import Form from "next/form";
import type { ComponentProps } from "react";

/**
 * GET form (client-side navigation) that submits itself when a select or date changes, so
 * filters apply at once. The submit button inside stays for keyboard users and without JS.
 */
export function AutoSubmitForm({ children, ...props }: Omit<ComponentProps<typeof Form>, "onChange" | "onSubmit">) {
  return (
    <Form
      {...props}
      onSubmit={(e) => {
        // Keep URLs clean: "all" choices (empty values) are left out of the query string.
        const empty = [...e.currentTarget.querySelectorAll<HTMLSelectElement | HTMLInputElement>("select[name], input[name]")].filter((el) => !el.value && !el.disabled);
        for (const el of empty) el.disabled = true;
        setTimeout(() => empty.forEach((el) => (el.disabled = false)), 0);
      }}
      onChange={(e) => {
        const t = e.target as HTMLElement;
        if (t instanceof HTMLSelectElement) e.currentTarget.requestSubmit();
      }}
    >
      {children}
    </Form>
  );
}
