import { createContext, useContext } from "react";
import type { AppConfig } from "@orbs/protocol/types";

export const ConfigContext = createContext<AppConfig | undefined>(undefined);

export function useConfig(): AppConfig {
	const config = useContext(ConfigContext);
	if (!config) throw new Error("config not loaded");
	return config;
}
