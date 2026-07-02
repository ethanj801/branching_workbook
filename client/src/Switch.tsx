import { type ReactNode } from "react";

type SwitchProps = {
  label: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Extra content after the label, for example an info dot. */
  children?: ReactNode;
};

/**
 * The shared toggle used by the Diverse and ban-list Enabled controls. The
 * checkbox is visually hidden and the track plus knob render the switch. Pass an
 * info dot or similar as children to place it between the label and the toggle.
 */
export default function Switch({
  label,
  checked,
  onChange,
  disabled,
  children,
}: SwitchProps) {
  return (
    <label className="bw-switch">
      <span>{label}</span>
      {children}
      <input
        type="checkbox"
        className="bw-switch-input"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span className="bw-switch-track" aria-hidden="true">
        <span className="bw-switch-knob" />
      </span>
    </label>
  );
}
