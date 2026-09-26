def total_after_discount(amount: int, percent: int | None) -> int:
    return amount - (amount * percent // 100)
