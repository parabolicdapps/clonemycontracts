// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Locks tokens for a beneficiary: nothing before `cliff`, then linear release until `start + duration`.
contract LinearVesting {
    IERC20Min public immutable token;
    address public immutable beneficiary;
    address public immutable funder;
    uint64 public immutable start;
    uint64 public immutable cliff;
    uint64 public immutable duration;
    uint256 public totalAllocation;
    uint256 public released;
    bool public revoked;

    event Funded(uint256 amount);
    event Released(uint256 amount);
    event Revoked(uint256 refunded);

    constructor(IERC20Min _token, address _beneficiary, uint64 _start, uint64 cliffSeconds, uint64 _duration) {
        require(_beneficiary != address(0), "zero beneficiary");
        require(_duration > 0 && cliffSeconds <= _duration, "bad schedule");
        token = _token;
        beneficiary = _beneficiary;
        funder = msg.sender;
        start = _start;
        cliff = _start + cliffSeconds;
        duration = _duration;
    }

    function fund(uint256 amount) external {
        require(msg.sender == funder, "not funder");
        require(!revoked, "revoked");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        totalAllocation += amount;
        emit Funded(amount);
    }

    function vested() public view returns (uint256) {
        if (block.timestamp < cliff) return 0;
        if (block.timestamp >= start + duration) return totalAllocation;
        return (totalAllocation * (block.timestamp - start)) / duration;
    }

    function releasable() public view returns (uint256) {
        return vested() - released;
    }

    function release() external {
        uint256 amount = releasable();
        require(amount > 0, "nothing to release");
        released += amount;
        require(token.transfer(beneficiary, amount), "transfer failed");
        emit Released(amount);
    }

    /// Funder stops vesting; unvested tokens go back to the funder, vested ones stay claimable.
    function revoke() external {
        require(msg.sender == funder, "not funder");
        require(!revoked, "already revoked");
        uint256 vestedNow = vested();
        uint256 refund = totalAllocation - vestedNow;
        revoked = true;
        totalAllocation = vestedNow;
        if (refund > 0) require(token.transfer(funder, refund), "refund failed");
        emit Revoked(refund);
    }
}
