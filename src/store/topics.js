// Until topics reach the app (design §10 slice 3), each user has one library, stored as a
// topic of its own. The primary (owner) user's library is `ai-pm`, the topic its data moved
// to in slice 3; any other user gets `{userId}-library`. Both backends use this, so review
// events carry the same topic id whichever store wrote them.
export const DEFAULT_TOPIC_ID = 'ai-pm';
export const libraryTopicId = (userId, primaryUserId) =>
  (primaryUserId && userId === primaryUserId ? DEFAULT_TOPIC_ID : `${userId}-library`);
