import { useState, useMemo, useCallback } from "react";
import { Text, useInput } from "ink";
import chalk from "chalk";

type Props = {
  placeholder?: string;
  suggestions?: string[];
  onSubmit?: (value: string) => void;
};

export function CommandInput({ placeholder = "", suggestions, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);

  const suggestion = useMemo(() => {
    if (value.length === 0) return undefined;
    const match = suggestions?.find((s) => s.startsWith(value));
    return match ? match.slice(value.length) : undefined;
  }, [value, suggestions]);

  const insert = useCallback((text: string) => {
    setValue((v) => v.slice(0, cursor) + text + v.slice(cursor));
    setCursor((c) => c + text.length);
  }, [cursor]);

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || (key.ctrl && input === "c")) return;

    if (key.tab) {
      if (suggestion) {
        insert(suggestion);
      }
      return;
    }

    if (key.return) {
      const final = suggestion ? value + suggestion : value;
      onSubmit?.(final);
      setValue("");
      setCursor(0);
      return;
    }

    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
    } else if (key.rightArrow) {
      if (cursor === value.length && suggestion) {
        insert(suggestion);
      } else {
        setCursor((c) => Math.min(value.length, c + 1));
      }
    } else if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => c - 1);
      }
    } else {
      insert(input);
    }
  });

  const rendered = useMemo(() => {
    if (value.length === 0) {
      return placeholder
        ? chalk.inverse(placeholder[0]) + chalk.dim(placeholder.slice(1))
        : chalk.inverse(" ");
    }

    let result = "";
    for (let i = 0; i < value.length; i++) {
      result += i === cursor ? chalk.inverse(value[i]!) : value[i];
    }

    if (suggestion) {
      if (cursor === value.length) {
        result += chalk.inverse(suggestion[0]) + chalk.dim(suggestion.slice(1));
      } else {
        result += chalk.dim(suggestion);
      }
    } else if (cursor === value.length) {
      result += chalk.inverse(" ");
    }

    return result;
  }, [value, cursor, suggestion, placeholder]);

  return <Text>{rendered}</Text>;
}
