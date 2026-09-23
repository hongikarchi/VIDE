/** Only public publication files, scoped by logged-in user and project. */
export async function uploadStorage(key: string, value?: string | null): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vide-sharing-uploads', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pending');
    request.onerror = () =>
      reject(new Error('게시 재시도 자료를 이 브라우저에 저장하지 못했습니다.'));
    request.onblocked = () => reject(new Error('다른 공유 창을 닫고 다시 시도해 주세요.'));
    request.onsuccess = () => {
      const db = request.result,
        transaction = db.transaction('pending', value === undefined ? 'readonly' : 'readwrite'),
        store = transaction.objectStore('pending');
      let result: string | null = null;
      const operation =
        value === undefined
          ? store.get(key)
          : value === null
            ? store.delete(key)
            : store.put(value, key);
      operation.onsuccess = () => {
        if (value === undefined && typeof operation.result === 'string') result = operation.result;
      };
      transaction.oncomplete = () => {
        db.close();
        resolve(result);
      };
      transaction.onerror = () => {
        db.close();
        reject(new Error('게시 재시도 자료를 저장하지 못했습니다.'));
      };
      transaction.onabort = transaction.onerror;
    };
  });
}
