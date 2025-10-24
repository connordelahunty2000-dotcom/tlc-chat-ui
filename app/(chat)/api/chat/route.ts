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
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

export async function POST(request: Request) {
  // ------- Parse and validate body -------
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

  // ------- Auth -------
  const session = await auth();
  if (!session?.user) return new ChatSDKError("unauthorized:chat").toResponse();

  // ------- Simple daily rate limit using existing helper -------
  const userType: UserType = session.user.type;
  const messageCount = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError("rate_limit:chat").toResponse();
  }

  // ------- Ensure chat row exists -------
  const existing = await getChatById({ id });
  if (existing && existing.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }
  if (!existing) {
    const title = await generateTitleFromUserMessage({ message });
    await saveChat({
      id,
      userId: session.user.id,
      title,
      visibility: selectedVisibilityType,
    });
  }

  // ------- Build history + persist this user message immediately -------
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

  // ------- n8n proxy only (NO AI Gateway) -------
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
        history,            // full UI-formatted history
        user: session.user, // include if your flow needs it
      }),
    });
  } catch (err) {
    console.error("Failed to reach n8n webhook:", err);
  }

  if (!res) return new ChatSDKError("offline:chat").toResponse();

  // ------- Stream n8n response to UI (or buffer if non-streaming) -------
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        if (!res!.body) {
          const text = await res!.text();
          writer.write({ type: "text-delta", data: text });
          writer.close();
          return;
        }
        const reader = res!.body.getReader();
        const td = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          writer.write({ type: "text-delta", data: td.decode(value) });
        }
        writer.close();
      } catch (e) {
        console.error("Proxy stream error", e);
        writer.write({
          type: "error",
          data: "There was an error connecting to the assistant.",
        });
        writer.close();
      }
    },
    generateId: generateUUID,
    onFinish: async ({ messages }) => {
      // persist assistant messages
      await saveMessages({
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: m.parts,
          createdAt: new Date(),
          attachments: [],
          chatId: id,
        })),
      });
    },
    onError: () => "Oops, an error occurred!",
  });

  return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
}
