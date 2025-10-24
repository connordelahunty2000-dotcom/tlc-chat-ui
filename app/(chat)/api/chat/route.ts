// app/(chat)/api/chat/route.ts
import { JsonToSseTransformStream, createUIMessageStream } from "ai";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { ChatSDKError } from "@/lib/errors";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import {
  getMessagesByChatId,
  getMessageCountByUserId,
  getChatById,
  saveChat,
  saveMessages,
} from "@/lib/db/queries";
import type { ChatMessage } from "@/lib/types";
import type { VisibilityType } from "@/components/visibility-selector";
import type { ChatModel } from "@/lib/ai/models";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

// Finish the UI writer safely across SDK versions.
function finishWriter(writer: unknown) {
  const w = writer as any;
  if (w?.end && typeof w.end === "function") return w.end();
  if (w?.close && typeof w.close === "function") return w.close();
  if (w?.finish && typeof w.finish === "function") return w.finish();
}

// Make a simple title without AI (safe across message part shapes)
function makeTitleFromMessage(msg: ChatMessage, fallback = "New chat") {
  try {
    const parts: any[] = (msg as any)?.parts ?? [];
    let firstText: string | undefined;

    for (const p of parts) {
      if (p && typeof p === "object") {
        if (p.type === "text" && typeof p.text === "string") {
          firstText = p.text;
          break;
        }
        if (p.type === "input_text" && typeof p.input_text === "string") {
          firstText = p.input_text;
          break;
        }
      } else if (typeof p === "string") {
        firstText = p;
        break;
      }
    }

    if (!firstText) firstText = String(parts[0] ?? "");
    if (!firstText) return fallback;

    const words = firstText.trim().split(/\s+/).slice(0, 8).join(" ");
    const clipped = words.length > 80 ? words.slice(0, 80) : words;
    return clipped || fallback;
  } catch {
    return fallback;
  }
}

export async function POST(request: Request) {
  // 1) Parse body
  let body: PostRequestBody;
  try {
    body = postRequestBodySchema.parse(await request.json());
  } catch {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const {
    id,
    message,
    selectedChatModel,
    selectedVisibilityType,
  }: {
    id: string;
    message: ChatMessage;
    selectedChatModel: ChatModel["id"];
    selectedVisibilityType: VisibilityType;
  } = body;

  // 2) Auth
  const session = await auth();
  if (!session?.user) return new ChatSDKError("unauthorized:chat").toResponse();

  // 3) Simple rate limit
  const userType: UserType = session.user.type;
  const messageCount = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError("rate_limit:chat").toResponse();
  }

  // 4) Ensure chat exists (no AI title; deterministic)
  const chat = await getChatById({ id });
  if (chat && chat.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }
  if (!chat) {
    const title = makeTitleFromMessage(message);
    await saveChat({
      id,
      userId: session.user.id,
      title,
      visibility: selectedVisibilityType,
    });
  }

  // 5) Build history + persist the user message
  const uiHistory = [
    ...convertToUIMessages(await getMessagesByChatId({ id })),
    message,
  ];
  await saveMessages({
    messages: [
      {
        chatId: id,
        id: message.id,
        role: "user",
        parts: message.parts,
        attachments: [],
        createdAt: new Date(),
      },
    ],
  });

  // 6) Call your n8n webhook (no AI Gateway anywhere)
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("Missing N8N_WEBHOOK_URL");
    return new ChatSDKError("offline:chat").toResponse();
  }

  let res: Response | null = null;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.N8N_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${process.env.N8N_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        chatId: id,
        model: selectedChatModel,
        message,
        history: uiHistory,
        user: session.user,
      }),
    });
  } catch (err) {
    console.error("Failed to reach n8n webhook:", err);
  }

  if (!res) return new ChatSDKError("offline:chat").toResponse();

  // ...inside createUIMessageStream({ execute: ({ writer }) => { ... } })
const msgId = generateUUID();

(async () => {
  try {
    const res = await fetch(process.env.N8N_WEBHOOK_URL!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streamId,                    // pass through if you set it earlier
        chatId: id,
        user: session.user,
        message,                     // the raw message the user sent
        history: uiMessages,         // previous messages if you send them
      }),
    });

    // If n8n itself failed, surface the error text instead of throwing.
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      writer.write({
        type: "text-delta",
        delta:
          errText ||
          `Sorry — the workflow returned ${res.status} ${res.statusText}.`,
        id: msgId,
      });
      writer.done();
      return;
    }

    // Be robust to either JSON or text replies from "Respond to Webhook".
    const ct = res.headers.get("content-type") || "";
    let answer = "";

    if (ct.includes("application/json")) {
      const data: any = await res.json().catch(() => ({}));
      // Try common keys; fall back to stringify
      answer =
        String(
          data.output ??
            data.answer ??
            data.text ??
            data.message ??
            ""
        ) || JSON.stringify(data);
    } else {
      answer = await res.text();
    }

    if (!answer) {
      answer = "I didn’t receive a reply from the agent.";
    }

    writer.write({ type: "text-delta", delta: answer, id: msgId });
    writer.done(); // **always** finish the UI stream
  } catch (e: any) {
    // Never throw—stream a friendly error and end cleanly
    console.error("n8n fetch failed:", e?.message || e);
    writer.write({
      type: "text-delta",
      delta: "Sorry — I couldn’t reach the agent right now.",
      id: msgId,
    });
    writer.done();
  }
})();


  return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
}
