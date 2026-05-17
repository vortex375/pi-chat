import { afterEach, describe, expect, it, vi } from "vitest";
import { createSession, deleteSession } from "./api";

describe("api request helper", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("omits the json content-type header for body-less delete requests", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchSpy);

		await deleteSession("session-1");

		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/sessions/session-1",
			expect.objectContaining({ method: "DELETE", headers: expect.any(Headers) }),
		);

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.has("content-type")).toBe(false);
	});

	it("adds the json content-type header when a request body is present", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: "session-1",
					displayName: "Test session",
					hasCustomName: false,
					firstMessage: "(no messages)",
					createdAt: new Date("2026-05-14T12:00:00.000Z").toISOString(),
					modifiedAt: new Date("2026-05-14T12:00:00.000Z").toISOString(),
					messages: [],
				}),
				{ status: 201, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchSpy);

		await createSession();

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("content-type")).toBe("application/json");
	});
});