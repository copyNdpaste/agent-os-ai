# Tests

테스트는 Given/When/Then 구조로 작성합니다. (BDD)

- TS: `tests/**/*.spec.ts` — vitest
- Python: `tests/python/**/test_*.py` — pytest

## 컨벤션

```ts
describe('UnitName', () => {
  it('어떤 조건에서 어떤 결과가 나오는지 한국어로', () => {
    // Given: 준비된 상태
    // When:  대상 동작
    // Then:  기대 결과
  });
});
```

```python
def test_어떤_조건에서_어떤_결과가_나오는지():
    # Given: ...
    # When:  ...
    # Then:  ...
```

## 실행

```bash
npm test               # TS
.venv/bin/pytest       # Python
```
