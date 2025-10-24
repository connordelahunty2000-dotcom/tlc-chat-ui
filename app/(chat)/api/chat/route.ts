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

/** Finish the UI writer safely across SDK versions (done/close/end/finish). */
function finishWriter(writer: unknown) {
  const w = writer as any;
  if (typeof w?.done === "function") return w.done();
  if (typeof w?.close === "function") return w.close();
  if (typeof w?.end === "function") return w.end();
  if (typeof w?.finish === "function") return w.finish();
}

/** Deterministic title from first text-like part (no AI). */
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
    return words.length > 80 ? words.slice(0, 80) : words;
  } catch {
    return fallback;
  }
}

export async function POST(request: Request) {
  // 1) Parse request body
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

  // 3) Rate limit
  const userType: UserType = session.user.type;
  const messageCount = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError("rate_limit:chat").toResponse();
  }

  // 4) Ensure chat exists
  const chat = await getChatById({ id });
  if (chat && chat.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }
  if (!chat) {
    await saveChat({
      id,
      userId: session.user.id,
      title: makeTitleFromMessage(message),
      visibility: selectedVisibilityType,
    });
  }

  // 5) Build history and persist user message
  const history = [
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

  // 6) Validate webhook config
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("Missing N8N_WEBHOOK_URL");
    return new ChatSDKError("offline:chat").toResponse();
  }

  // 7) Stream response to the UI and fetch from n8n inside the writer
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const msgId = generateUUID();

      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(process.env.N8N_WEBHOOK_TOKEN
              ? { Authorization: `Bearer ${process.env.N8N_WEBHOOK_TOKEN}` }
              : {}),
          },
          body: JSON.stringify({
            chatId: id,
            model: selectedChatModel,
            message,
            history,
            user: session.user,
          }),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          (writer as any).write({
            type: "text-delta",
            delta:
              errText ||
              `Sorry — the workflow returned ${res.status} ${res.statusText}.`,
            id: msgId,
          });
          finishWriter(writer);
          return;
        }

        // Parse either JSON or text from Respond to Webhook
        const ct = res.headers.get("content-type") || "";
        let answer = "";
        if (ct.includes("application/json")) {
          const data: any = await res.json().catch(() => ({}));
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

        if (!answer) answer = "I didn’t receive a reply from the agent.";

        // Stream to UI
        (writer as any).write({ type: "text-delta", delta: answer, id: msgId });
        finishWriter(writer);

        // Persist assistant message
        try {
          await saveMessages({
            messages: [
              {
                chatId: id,
                id: msgId,
                role: "assistant",
                parts: [{ type: "text", text: answer }] as any,
                attachments: [],
                createdAt: new Date(),
              },
            ],
          });
        } catch (dbErr) {
          console.warn("Unable to persist assistant message:", dbErr);
        }
      } catch (e: any) {
        console.error("n8n fetch failed:", e?.message || e);
        (writer as any).write({
          type: "text-delta",
          delta: "Sorry — I couldn’t reach the agent right now.",
          id: msgId,
        });
        finishWriter(writer);
      }
    },
  });

  return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
}
