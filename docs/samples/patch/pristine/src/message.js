export function buildMessage(name, count) {
    const suffix = count > 1 ? 's' : '';
    return 'Hello, ' + name + '! You have ' + count + ' new message' + suffix + '.';
}

export function buildEmptyMessage() {
    return 'No new messages.';
}
