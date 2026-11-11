import type { ToolResult } from "../tools/types.js";
import { logger } from "../utils/logger.js";
import { withMailboxMutationDeadline, type MailboxMutationDeadlineOptions } from "./mailbox-mutation-deadline.js";

interface MailToolExecution {
  invoke: (recordDelivery: (messageId?: string) => void) => Promise<ToolResult>;
  validate: () => Promise<void>;
  deadline?: MailboxMutationDeadlineOptions;
}

/** Bound handler and validation together; preserve only an SMTP-confirmed receipt when later work fails. */
export async function executeMailTool(options: MailToolExecution): Promise<ToolResult> {
  let delivery: { messageId?: string } | undefined;
  const operation = async () => {
    const result = await options.invoke(messageId => { delivery = { messageId }; });
    await options.validate();
    return result;
  };
  try {
    return options.deadline
      ? await withMailboxMutationDeadline(options.deadline, operation)
      : await operation();
  } catch (error) {
    if (!delivery) throw error;
    logger.warn("Email delivery completed but follow-up checks failed", "MailToolExecution", error);
    // Never reuse the handler result or error text here: either can contain
    // original message content that the final access check no longer permits.
    const receipt = {
      success: true,
      ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
      reason: "Email delivery completed. Follow-up mailbox checks did not finish. Do not resend this message.",
    };
    return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt };
  }
}
