import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

type CommonProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  trailing?: ReactNode;
};

type InputProps = InputHTMLAttributes<HTMLInputElement> & CommonProps;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, trailing, id, className, ...rest },
  ref,
) {
  const inputId = id ?? rest.name ?? `inp-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div className={`field ${error ? "field--error" : ""} ${className ?? ""}`}>
      {label ? (
        <label htmlFor={inputId} className="field__label">
          {label}
        </label>
      ) : null}
      <div className="field__control">
        <input ref={ref} id={inputId} className="field__input" {...rest} />
        {trailing ? <span className="field__trailing">{trailing}</span> : null}
      </div>
      {error ? <p className="field__error">{error}</p> : null}
      {!error && hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & CommonProps;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, id, className, ...rest },
  ref,
) {
  const inputId = id ?? rest.name ?? `txa-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div className={`field ${error ? "field--error" : ""} ${className ?? ""}`}>
      {label ? (
        <label htmlFor={inputId} className="field__label">
          {label}
        </label>
      ) : null}
      <textarea ref={ref} id={inputId} className="field__textarea" {...rest} />
      {error ? <p className="field__error">{error}</p> : null}
      {!error && hint ? <p className="field__hint">{hint}</p> : null}
    </div>
  );
});
