import { Fragment, type ReactNode } from "react";

// Fills {name} placeholders in a catalog string with nodes, so a value can carry its own markup (a <bdi> around a clock).
export function renderTemplate(template: string, values: Readonly<Record<string, ReactNode>>): ReactNode {
  return template.split(/(\{[a-z]+\})/).map((part, index) => {
    const name = /^\{([a-z]+)\}$/.exec(part)?.[1];
    return name !== undefined && name in values ? <Fragment key={index}>{values[name]}</Fragment> : part;
  });
}
