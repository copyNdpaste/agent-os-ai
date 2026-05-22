"""pytest 인프라 sanity check."""


def test_pytest_러너가_동작한다():
    # Given: 단순 산술식
    a, b = 2, 3

    # When: 두 수를 더함
    total = a + b

    # Then: 결과는 5
    assert total == 5
