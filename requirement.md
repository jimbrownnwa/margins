## Reading-to-practice companion

Build this around one experience: **you share something you’ve read, and your reading partner helps you stay with the idea a little longer.**

The goal is enjoyable conversation, deeper understanding, and occasionally discovering a connection you wouldn’t have noticed yourself.

**The concept: “Margins” — a personal reading companion**

You can have several books going at once. Margins remembers your conversations about each, notices connections across books, and gradually learns which questions interest you.

Its personality: curious, thoughtful, willing to disagree. It asks one good question at a time and gives you room to form your own interpretation.

**1. How you interact with it**

For the first version, I’d use a private Telegram or Slack conversation. That keeps it accessible from your phone without needing to build an app.

You could send:

- A passage you copied.
- A photo of a page.
- Your own observation or question.
- A reply to an earlier discussion.

When you introduce a book, it asks what drew you to it. Chapter or page numbers are optional. It tracks where you are so discussion stays within what you’ve read.

**2. What it actually does**

|Capability|Experience|
|---|---|
|**Explore a passage**|Helps unpack an idea, offers a possible interpretation, and asks what you make of it.|
|**Follow your curiosity**|Chooses whether an example, counterargument, question, or explanation would help the conversation.|
|**Connect your reading**|Retrieves a relevant earlier conversation and explains the connection, including where the ideas differ.|
|**Revisit an idea**|With your agreement, brings something back later to see whether your view has changed.|
|**Suggest an experiment**|When you want to try an idea, helps devise a small everyday experiment and later asks what you noticed.|

Experiments should be optional. A passage can simply be interesting without becoming an assignment.

**3. An example conversation**

**You:** “This author says we suffer because we identify with our thoughts. I understand the words, but I’m not sure I understand the experience.”

**Margins:** “Think of a moment when a thought like ‘I handled that badly’ became a conclusion about who you are. The distinction the author seems to be drawing is between noticing that thought and accepting it as a description of yourself. Does that fit your reading, or do you think they’re making a stronger claim?”

After a few exchanges, it might offer:

“Would you like to leave this here, or try noticing that distinction once tomorrow?”

If you choose the experiment, you decide whether and when it follows up.

**4. What it remembers**

I’d give it three kinds of memory:

- **Books:** title, author, reading position, and what interests you about each.
- **Reading notes:** passages, your interpretations, unresolved questions, and links between conversations.
- **Follow-ups:** ideas you explicitly asked to revisit and experiments you chose.

Each saved interpretation should distinguish **the author’s words, your view, and the agent’s interpretation**. Connections should link back to the original note so you can inspect them.

You should also be able to say “forget that,” “that’s not what I meant,” or “show me what you remember.”

**5. What makes it an agent**

It has a small set of tools: retrieve past notes, save a reflection, connect two notes, and arrange an agreed follow-up.

On each message, it decides which tools—if any—would help. For example, it might search earlier discussions before claiming two authors agree. It should acknowledge when it lacks enough context, especially when you’ve shared only a short excerpt.

Trigger.dev would run that background work and the follow-up tasks. A database would hold the lasting memory; the model would handle interpretation and conversation.

**6. The first version I’d build**

Keep the initial scope to:

1. Private text conversations.
2. Multiple books with separate conversation history.
3. Saving and retrieving passages and reflections.
4. Connections to previous reading.
5. Optional, explicitly requested follow-ups.

Page photos and proactive resurfacing can come after the conversation feels good.

For a two-week personal experiment, the main test is simple: **Did it make you want to return to a book or think longer about something you read?** That’s the experience I’d optimize before adding features.