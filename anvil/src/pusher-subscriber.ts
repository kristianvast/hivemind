import PusherDefault from "pusher-js";
import type { Channel } from "pusher-js";
import type { Options as PusherOptions } from "pusher-js/types/src/core/options.js";

import { getConfig } from "./config.js";
import { log } from "./log.js";

interface PusherStateChange {
	previous: string;
	current: string;
}

interface DispatchPayload {
	briefId?: unknown;
}

const Pusher = PusherDefault as unknown as new (appKey: string, options: PusherOptions) => {
	connection: {
		bind: (eventName: string, callback: (data: unknown) => void) => void;
	};
	subscribe: (channelName: string) => Channel;
	disconnect: () => void;
};

type PusherInstance = InstanceType<typeof Pusher>;

function isPusherStateChange(data: unknown): data is PusherStateChange {
	return (
		typeof data === "object" &&
		data !== null &&
		"previous" in data &&
		"current" in data &&
		typeof data.previous === "string" &&
		typeof data.current === "string"
	);
}

export async function startPusherSubscriber(
	onBrief: (briefId: string) => Promise<void>,
): Promise<{ stop: () => Promise<void>; pusher: PusherInstance }> {
	const config = getConfig();
	if (config.MOCK_MODE === "true") {
		log.info("[pusher] MOCK MODE — no real subscription");
		return {
			stop: async () => undefined,
			pusher: new Pusher(config.PUSHER_KEY, { cluster: config.PUSHER_CLUSTER }),
		};
	}

	const pusher = new Pusher(config.PUSHER_KEY, {
		cluster: config.PUSHER_CLUSTER,
		forceTLS: true,
		enabledTransports: ["ws"],
		activityTimeout: 30000,
		pongTimeout: 10000,
	});
	pusher.connection.bind("state_change", (data: unknown) => {
		if (isPusherStateChange(data)) log.info("[pusher] state", { previous: data.previous, current: data.current });
	});
	pusher.connection.bind("error", (err: unknown) => log.error("[pusher] error", { err: String(err) }));

	const channel: Channel = pusher.subscribe(config.PUSHER_CHANNEL);
	channel.bind("pusher:subscription_succeeded", () =>
		log.info("[pusher] subscribed", { channel: config.PUSHER_CHANNEL }),
	);
	channel.bind("brief.dispatched", async (data: DispatchPayload) => {
		if (typeof data?.briefId !== "string" || data.briefId.length === 0) {
			log.warn("[pusher] bad payload", { data });
			return;
		}
		try {
			await onBrief(data.briefId);
		} catch (err) {
			log.error("[pusher] onBrief failed", { briefId: data.briefId, err: String(err) });
		}
	});

	return {
		stop: async () => {
			pusher.disconnect();
		},
		pusher,
	};
}
