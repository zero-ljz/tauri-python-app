import { describe, expect, it } from "vitest";
import { redactText, redactValue } from "@/lib/redact";

describe("redaction", () => {
  it("redacts nested secret keys without changing safe values", () => {
    expect(
      redactValue({
        profile: { apiToken: "secret", name: "Ada" },
        authorization: "Bearer abc.def",
      }),
    ).toEqual({
      profile: { apiToken: "[REDACTED]", name: "Ada" },
      authorization: "[REDACTED]",
    });
  });

  it("redacts credentials embedded in log text", () => {
    const value = redactText("token=abc Authorization: Bearer xyz.123");
    expect(value).not.toContain("abc");
    expect(value).not.toContain("xyz.123");
  });
});
