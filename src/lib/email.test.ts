import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailError, postToResend, resendApiKeyFrom } from "./email";

const email = { to: "tenant@example.test", subject: "Payment received", text: "You were paid." };
const config = { apiKey: "re_test_key", from: "PayFlow <billing@example.test>" };

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("resendApiKeyFrom", () => {
  it("returns a real key", () => {
    expect(resendApiKeyFrom("re_live_abc123")).toBe("re_live_abc123");
    expect(resendApiKeyFrom("  re_live_abc123  ")).toBe("re_live_abc123");
  });

  it("treats a missing or empty value as not configured", () => {
    expect(resendApiKeyFrom(undefined)).toBeUndefined();
    expect(resendApiKeyFrom("")).toBeUndefined();
    expect(resendApiKeyFrom("   ")).toBeUndefined();
  });

  it("treats the placeholder copied from .env.example as not configured", () => {
    expect(resendApiKeyFrom("re_...")).toBeUndefined();
  });
});

describe("postToResend", () => {
  it("posts the email with the API key and the idempotency key", async () => {
    const fetchMock = stubFetch(200, { id: "email_123" });

    const result = await postToResend(config, email, "payment_received:evt_1");

    expect(result).toEqual({ id: "email_123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
      // What makes a retried send safe: the provider answers a repeat of
      // this key with the first result instead of sending again.
      "Idempotency-Key": "payment_received:evt_1",
    });
    expect(JSON.parse(init.body)).toEqual({
      from: "PayFlow <billing@example.test>",
      to: ["tenant@example.test"],
      subject: "Payment received",
      text: "You were paid.",
    });
  });

  it("bounds how long it waits for the provider", async () => {
    const fetchMock = stubFetch(200, { id: "email_123" });

    await postToResend(config, email, "key");

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([429, 500, 503, 408, 409])(
    "reports a %i as something a retry can fix",
    async (status) => {
      stubFetch(status, { message: "try later" });

      const error = await postToResend(config, email, "key").catch((err) => err);

      expect(error).toBeInstanceOf(EmailError);
      expect(error).toMatchObject({ statusCode: status, permanent: false });
    }
  );

  it.each([400, 401, 403, 422])(
    "reports a %i as permanent — the same request will never succeed",
    async (status) => {
      stubFetch(status, { message: "invalid `to` field" });

      const error = await postToResend(config, email, "key").catch((err) => err);

      expect(error).toBeInstanceOf(EmailError);
      expect(error).toMatchObject({ statusCode: status, permanent: true });
      expect(error.message).toContain("invalid `to` field");
    }
  );
});
