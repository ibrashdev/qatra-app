import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ErrorSummary } from "@/components/ui/ErrorSummary";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextField } from "@/components/ui/TextField";
import { TextLink } from "@/components/ui/TextLink";

describe("Icon: the one seam to the icon set", () => {
  const names: IconName[] = ["back", "check", "close", "droplet", "error", "eye", "eye-off", "info", "pause", "success", "warning", "today", "games", "progress", "settings"];

  it.each(names)("renders %s as a decorative line glyph in the current colour", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("fill", "none");
    expect(svg).not.toHaveAttribute("aria-label");
    expect(svg).not.toHaveAttribute("role");
  });

  it("draws the line at 1.5 and at 2 only for an active or selected state (UI-tokens 4)", () => {
    const { container, rerender } = render(<Icon name="eye" />);
    expect(container.querySelector("svg")).toHaveAttribute("stroke-width", "1.5");
    rerender(<Icon name="eye" active />);
    expect(container.querySelector("svg")).toHaveAttribute("stroke-width", "2");
  });

  it("mirrors the back arrow in right-to-left and no other glyph (UI-tokens 5)", () => {
    for (const name of names) {
      const { container, unmount } = render(<Icon name={name} />);
      const mirrored = container.querySelector("svg")?.classList.contains("rtl:-scale-x-100");
      expect(mirrored, name).toBe(name === "back");
      unmount();
    }
  });

  it("takes its size from the icon tokens: 16, 20, 24 and 32 px, scaling with the browser font size", () => {
    const sizes = { sm: "size-icon-sm", md: "size-icon-md", lg: "size-icon-lg", xl: "size-icon-xl" } as const;
    for (const [size, className] of Object.entries(sizes)) {
      const { container, unmount } = render(<Icon name="info" size={size as keyof typeof sizes} />);
      expect(container.querySelector("svg"), size).toHaveClass(className, "shrink-0");
      unmount();
    }
    const { container } = render(<Icon name="info" />);
    expect(container.querySelector("svg")).toHaveClass("size-icon-lg");
  });
});

describe("Banner (UI-tokens 6.8)", () => {
  it.each([
    ["info", "border-info-edge", "bg-info-tint", "text-info-ink", "text-info-edge"],
    ["success", "border-success-edge", "bg-success-tint", "text-success-ink", "text-success-edge"],
    ["warning", "border-warning-edge", "bg-warning-tint", "text-warning-ink", "text-warning-edge"],
    ["error", "border-error-edge", "bg-error-tint", "text-error-ink", "text-error-edge"],
  ] as const)("%s uses its own tokens for border, fill, text and glyph, and carries a glyph beside the phrase", (variant, border, fill, text, glyph) => {
    const { container } = render(<Banner variant={variant}>Message</Banner>);
    const box = container.firstElementChild;
    expect(box).toHaveClass("rounded-md", "border", "p-q16", border, fill, text);
    const icon = container.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon?.parentElement).toHaveClass(glyph);
    expect(screen.getByText("Message")).toBeInTheDocument();
  });

  it("has no live-region role of its own unless the caller asks for alert", () => {
    const { container, rerender } = render(<Banner variant="warning">Message</Banner>);
    expect(container.firstElementChild).not.toHaveAttribute("role");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(
      <Banner variant="error" role="alert">
        Message
      </Banner>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Message");
  });

  it("shows a title, an action and the id the caller gave it", () => {
    render(
      <Banner variant="info" id="banner-1" title="Title" action={<button type="button">Act</button>}>
        Body
      </Banner>,
    );
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Act" })).toBeInTheDocument();
    expect(screen.getByText("Body").closest("#banner-1")).not.toBeNull();
  });

  it("replaces the glyph with the icon the caller passes", () => {
    const { container } = render(
      <Banner variant="info" icon={<span data-testid="loader" />}>
        Message
      </Banner>,
    );
    expect(screen.getByTestId("loader")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("offers a dismiss button of at least 44 by 44 px with the name the caller gives, and calls back", async () => {
    const onDismiss = vi.fn();
    render(
      <Banner variant="success" dismiss={{ label: "Dismiss message", onDismiss }}>
        Message
      </Banner>,
    );
    const button = screen.getByRole("button", { name: "Dismiss message" });
    expect(button).toHaveClass("size-target");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(button);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("is not dismissible by default", () => {
    render(<Banner variant="info">Message</Banner>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("Button (UI-tokens 6.1)", () => {
  it("is a 48 px button of at least 88 px that does not submit unless it is told to", () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("min-h-button", "min-w-22", "text-button", "bg-primary", "text-on-primary");
  });

  it("can be the secondary outline or full width", () => {
    render(
      <Button variant="secondary" fullWidth>
        Go
      </Button>,
    );
    expect(screen.getByRole("button")).toHaveClass("border", "bg-surface", "text-primary-deep", "w-full");
  });

  it("keeps its label while loading, leads it with a spinner, marks aria-busy and ignores a press", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading onClick={onClick}>
        Logging in…
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Logging in…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).not.toBeDisabled();
    expect(container.querySelector("span[aria-hidden=true]")).toHaveClass("animate-spin", "motion-reduce:animate-none");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("stays focusable and ignores a press while aria-disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button aria-disabled onClick={onClick}>
        Wait
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Wait" });
    expect(button).not.toBeDisabled();
    await userEvent.tab();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("runs onClick when it is neither loading nor disabled", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stops the form from being sent by a press or by Enter in a field while it waits", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input aria-label="field" />
        <Button type="submit" loading>
          Sending
        </Button>
      </form>,
    );
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByLabelText("field"), "x{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends the form when it is idle, by press or by Enter in a field", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <input aria-label="field" />
        <Button type="submit">Send</Button>
      </form>,
    );
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByLabelText("field"), "x{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

describe("TextField (UI-tokens 6.2)", () => {
  it("has a visible label tied to the input, no placeholder, and passes input attributes on", () => {
    render(<TextField id="f" label="Username" name="username" autoComplete="username" spellCheck={false} />);
    const input = screen.getByLabelText("Username");
    expect(input).toHaveAttribute("id", "f");
    expect(input).toHaveAttribute("name", "username");
    expect(input).toHaveAttribute("autocomplete", "username");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).not.toHaveAttribute("placeholder");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(screen.getByText("Username").tagName).toBe("LABEL");
  });

  it("describes the input with the helper first and then the error, and marks it invalid", () => {
    render(<TextField id="f" label="Username" helper="Helper text" error="Error text" />);
    const input = screen.getByLabelText("Username");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0] as string)).toHaveTextContent("Helper text");
    expect(document.getElementById(ids[1] as string)).toHaveTextContent("Error text");
    // The error carries a glyph beside the phrase, never colour alone.
    const error = document.getElementById(ids[1] as string) as HTMLElement;
    expect(error).toHaveClass("text-error-ink");
    expect(error.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("describes the input with the error alone when there is no helper", () => {
    render(<TextField id="f" label="Username" error="Error text" />);
    const input = screen.getByLabelText("Username");
    expect(document.getElementById(input.getAttribute("aria-describedby") as string)).toHaveTextContent("Error text");
  });

  it("puts the border on a box around a borderless input, and swaps it for the error recipe", () => {
    const { container, rerender } = render(<TextField id="f" label="Username" />);
    const box = container.querySelector("input")?.parentElement as HTMLElement;
    expect(box).toHaveClass("min-h-input", "rounded-sm", "border", "border-edge", "bg-surface");
    expect(container.querySelector("input")).toHaveClass("bg-transparent", "outline-none");
    rerender(<TextField id="f" label="Username" error="Error text" />);
    expect(box).toHaveClass("border-error-edge");
    expect(box).not.toHaveClass("border-edge");
  });

  it("holds an end adornment inside the box and gives the input ref to the caller", () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<TextField id="f" label="Username" inputRef={ref} endAdornment={<button type="button">Adorn</button>} />);
    const box = container.querySelector("input")?.parentElement as HTMLElement;
    expect(within(box).getByRole("button", { name: "Adorn" })).toBeInTheDocument();
    expect(ref.current).toBe(screen.getByLabelText("Username"));
  });
});

describe("PasswordField (UI-screens P-08)", () => {
  function setup() {
    render(
      <form>
        <PasswordField id="p" label="Password" showLabel="Show password" hideLabel="Hide password" autoComplete="current-password" />
      </form>,
    );
    return { input: screen.getByLabelText("Password") as HTMLInputElement };
  }

  it("starts hidden, with dir=auto and no length cap or autocomplete=off", () => {
    const { input } = setup();
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("dir", "auto");
    expect(input).not.toHaveAttribute("maxlength");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    // The name carries the state; a pressed state on top of it would announce the toggle twice (O-07).
    expect(toggle).not.toHaveAttribute("aria-pressed");
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).toHaveClass("size-target");
  });

  it("shows and hides the text, names the action it will do, and keeps the typed value and focus", async () => {
    const { input } = setup();
    await userEvent.type(input, "a long synthetic phrase");
    const toggle = screen.getByRole("button", { name: "Show password" });
    await userEvent.click(toggle);

    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveValue("a long synthetic phrase");
    const hide = screen.getByRole("button", { name: "Hide password" });
    expect(hide).not.toHaveAttribute("aria-pressed");
    expect(hide).toHaveFocus();

    await userEvent.click(hide);
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).not.toHaveAttribute("aria-pressed");
  });

  it("is operated by Space and by Enter, and never submits the form", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordField id="p2" label="Password two" showLabel="Show" hideLabel="Hide" />
      </form>,
    );
    const toggle = screen.getByRole("button", { name: "Show" });
    toggle.focus();
    await userEvent.keyboard(" ");
    expect(screen.getByLabelText("Password two")).toHaveAttribute("type", "text");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByLabelText("Password two")).toHaveAttribute("type", "password");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("draws the eye for the action: the eye while hidden, the crossed eye while shown, neither mirrored", async () => {
    setup();
    const before = screen.getByRole("button", { name: "Show password" }).innerHTML;
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    const after = screen.getByRole("button", { name: "Hide password" }).innerHTML;
    expect(before).not.toEqual(after);
    expect(before).not.toMatch(/rtl:|scale-x/);
    expect(after).not.toMatch(/rtl:|scale-x/);
  });
});

describe("ErrorSummary (UI-screens P-03)", () => {
  it("is an alert with a title and one link per message, each 44 px high", () => {
    render(
      <ErrorSummary
        title="There are 2 errors in the form"
        items={[
          { fieldId: "a", message: "Enter your username." },
          { fieldId: "b", message: "Enter your password." },
        ]}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("There are 2 errors in the form");
    const links = within(alert).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Enter your username.", "#a"],
      ["Enter your password.", "#b"],
    ]);
    for (const link of links) expect(link).toHaveClass("min-h-target");
  });

  it("focuses the field of a message instead of jumping to an anchor", async () => {
    render(
      <>
        <ErrorSummary title="Errors" items={[{ fieldId: "target", message: "Fix this." }]} />
        <input id="target" aria-label="target" />
      </>,
    );
    await userEvent.click(screen.getByRole("link", { name: "Fix this." }));
    expect(screen.getByLabelText("target")).toHaveFocus();
  });
});

describe("TextField error hint (UI-screens P-10)", () => {
  it("shows the hint under the error only while there is an error, and describes the field with all three in order", () => {
    const { rerender } = render(<TextField id="f" label="Username" helper="Helper line" error="Error line" errorHint={<p>Hint line</p>} />);
    const input = screen.getByLabelText("Username");
    const described = (input.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Helper line", "Error line", "Hint line"]);

    rerender(<TextField id="f" label="Username" helper="Helper line" errorHint={<p>Hint line</p>} />);
    expect(screen.queryByText("Hint line")).not.toBeInTheDocument();
    expect(input.getAttribute("aria-describedby")?.split(" ")).toHaveLength(1);
  });

  it("lets the hint carry a link that can be reached", () => {
    render(<TextField id="f" label="Username" error="Error line" errorHint={<a href="/login">Log in</a>} />);
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
  });
});

describe("TextLink", () => {
  // jsdom cannot navigate: a press is observed, and the page stays.
  const stay = (event: Event) => event.preventDefault();
  beforeEach(() => document.addEventListener("click", stay));
  afterEach(() => document.removeEventListener("click", stay));

  it("is an underlined 44 px line in the link colour, and runs its handler when pressed", async () => {
    const onClick = vi.fn();
    render(
      <TextLink href="/terms" prefetch onClick={onClick}>
        Terms
      </TextLink>,
    );
    const link = screen.getByRole("link", { name: "Terms" });
    expect(link).toHaveAttribute("href", "/terms");
    expect(link).toHaveClass("min-h-target", "text-link", "underline");
    await userEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("needs no handler", async () => {
    render(<TextLink href="/login">Log in</TextLink>);
    await userEvent.click(screen.getByRole("link", { name: "Log in" }));
    expect(screen.getByRole("link", { name: "Log in" })).toBeInTheDocument();
  });
});

describe("Notice (UI-tokens 6.12)", () => {
  it("is small secondary text with the info glyph, no fill, no role and nothing to dismiss", () => {
    const { container } = render(<Notice>Fixed copy</Notice>);
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveTextContent("Fixed copy");
    expect(box).toHaveClass("text-small", "text-ink-secondary");
    expect(box.className).not.toMatch(/\bbg-/);
    expect(box).not.toHaveAttribute("role");
    expect(box).not.toHaveAttribute("aria-live");
    const glyph = box.querySelector("svg");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveClass("lucide-info");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("Checkbox (UI-tokens 6.3)", () => {
  function setup(props: Partial<React.ComponentProps<typeof Checkbox>> = {}) {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Checkbox id="consent" name="consent" label="I agree to the terms" {...props} />
        <button type="submit">Send</button>
      </form>,
    );
    return { box: screen.getByRole("checkbox", { name: "I agree to the terms" }) as HTMLInputElement, onSubmit };
  }

  it("is the native checkbox, unchecked, named by its visible label, with the label inside the row so the row is the target", () => {
    const { box } = setup();
    expect(box).not.toBeChecked();
    expect(box).toHaveAttribute("type", "checkbox");
    expect(box).toHaveAttribute("id", "consent");
    expect(box).toHaveAttribute("name", "consent");
    const row = box.closest("label");
    expect(row).toHaveClass("min-h-target", "cursor-pointer");
    expect(row).toHaveTextContent("I agree to the terms");
  });

  it("draws a 24 px box with a 2 px border and a check that the checked state reveals, hidden from assistive technology", () => {
    const { box } = setup();
    const drawn = box.parentElement as HTMLElement;
    expect(drawn).toHaveClass("size-checkbox", "border-2", "rounded-xs", "group-has-[:checked]:bg-primary", "group-has-[:checked]:border-primary");
    const check = drawn.querySelector("svg");
    expect(check).toHaveAttribute("aria-hidden", "true");
    expect(check).toHaveClass("lucide-check", "text-on-primary", "opacity-0", "group-has-[:checked]:opacity-100");
    // A faded glyph that comes after the input would otherwise sit on top of it and take the press.
    expect(check).toHaveClass("pointer-events-none");
    // The input lies over the box and is transparent, so the platform keeps the focus ring, the state and the keyboard.
    expect(box).toHaveClass("opacity-0", "absolute", "inset-0");
  });

  it("toggles by a press on the box, by a press on the label text, and by Space; Enter does not toggle it", async () => {
    const { box } = setup();
    await userEvent.click(box);
    expect(box).toBeChecked();
    await userEvent.click(screen.getByText("I agree to the terms"));
    expect(box).not.toBeChecked();
    box.focus();
    await userEvent.keyboard(" ");
    expect(box).toBeChecked();
    await userEvent.keyboard("{Enter}");
    expect(box).toBeChecked();
  });

  it("lets Enter send the form from the box, as the spec has it", async () => {
    const { box, onSubmit } = setup();
    box.focus();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("passes aria-required, a starting state and the input ref on", () => {
    const ref = createRef<HTMLInputElement>();
    const { box } = setup({ "aria-required": "true", defaultChecked: true, inputRef: ref });
    expect(box).toHaveAttribute("aria-required", "true");
    expect(box).toBeChecked();
    expect(ref.current).toBe(box);
  });

  it("marks an error with a red border, the message below with its glyph, aria-invalid and a description", () => {
    const { box } = setup({ error: "You must agree." });
    expect(box).toHaveAttribute("aria-invalid", "true");
    const message = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    expect(message).toHaveTextContent("You must agree.");
    expect(message).toHaveClass("text-error-ink");
    expect(message?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(box.parentElement).toHaveClass("border-error-edge");
    expect(box.parentElement).not.toHaveClass("border-edge");
  });

  it("has no error attributes without an error", () => {
    const { box } = setup();
    expect(box).not.toHaveAttribute("aria-invalid");
    expect(box).not.toHaveAttribute("aria-describedby");
    expect(box.parentElement).toHaveClass("border-edge");
  });
});
